import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { applyVertexColor } from "./vertex_color";
import { hashSeed } from "./random";
import {
  bridgeDeckHeight,
  bridgeDeckWidth,
  deckSolid,
  deckWalls,
  portalSolid,
  type Point2,
} from "./bridge_layout";

/*
 * Bridges and tunnels, from the tilegen `bridge`/`tunnel` features.
 *
 * A bridge way is drawn as a raised slab: the deck at the bridge height, a
 * parapet on each edge, and both ends ramped back to the ground so the deck
 * meets the basemap road instead of hanging in mid-air. A `man_made=bridge`
 * (or `building=bridge`) footprint is drawn as a flat deck slab.
 *
 * A tunnel is underground and invisible; the only honest, visible thing is its
 * portal, so that is all that is drawn here. The OSM `tunnel=*` ways become
 * portal Points in tilegen (not clipped lines), so no portal appears on an
 * arbitrary tile boundary. The underground part is not drawn on purpose.
 *
 * tilegen clips a bridge line or area to the tile, like water, so a long bridge
 * is split across tiles; the geometry is built in the same model space as the
 * buildings and merged per tile into one mesh.
 */

// concrete, slightly cool so it sits with the toon buildings; the tunnel portal
// is near-black to read as an opening
export const BRIDGE_COLOR = "#9aa0a6";
export const TUNNEL_COLOR = "#23272e";

function numberProperty(f: Geojson.Feature, key: string): number {
  const props = f.properties as Record<string, unknown> | null;
  const value = props ? Number(props[key]) : NaN;
  return value;
}

function stringProperty(f: Geojson.Feature, key: string): string | undefined {
  const props = f.properties as Record<string, unknown> | null;
  const value = props?.[key];
  return typeof value === "string" ? value : undefined;
}

function bridgeHeight(f: Geojson.Feature): number {
  const base = bridgeDeckHeight(numberProperty(f, "layer"));
  // Two decks at the same layer can overlap (the carriageways of a motorway, a
  // slip road joining it). Their flat tops would then be coplanar and z-fight;
  // a deterministic few-centimetre offset per feature separates them without
  // reading as a height difference.
  const id = typeof f.id === "string" ? f.id : "";
  return base + (hashSeed(id) % 5) * 0.01;
}

function applyGeometry(
  positions: number[],
  color: THREE.Color,
): THREE.BufferGeometry | null {
  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.computeVertexNormals();
  applyVertexColor(geometry, color);
  return geometry;
}

// the model-space polyline of a bridge part
function toModelLine(
  line: Geojson.Position[],
  originMeters: [number, number],
  scaleFactor: number,
): Point2[] {
  return line.map((c) =>
    toModelCoords([c[0], c[1]], originMeters, scaleFactor),
  );
}

function toModelRing(
  ring: Geojson.Position[],
  originMeters: [number, number],
  scaleFactor: number,
): Point2[] {
  return ring.map((c) =>
    toModelCoords([c[0], c[1]], originMeters, scaleFactor),
  );
}

// a flat deck slab for a `man_made=bridge` footprint: the top triangulated
// (earcut, via THREE.Shape) and the walls dropped to the ground
function polygonDeckPositions(
  rings: Geojson.Position[][],
  height: number,
  originMeters: [number, number],
  scaleFactor: number,
): number[] {
  const shape = new THREE.Shape(
    rings[0].map(
      (c) =>
        new THREE.Vector2(
          ...toModelCoords([c[0], c[1]], originMeters, scaleFactor),
        ),
    ),
  );
  for (let h = 1; h < rings.length; h++) {
    shape.holes.push(
      new THREE.Path(
        rings[h].map(
          (c) =>
            new THREE.Vector2(
              ...toModelCoords([c[0], c[1]], originMeters, scaleFactor),
            ),
        ),
      ),
    );
  }
  const top = new THREE.ShapeGeometry(shape);
  const flat = top.index ? top.toNonIndexed() : top;
  const attribute = flat.getAttribute("position");
  const positions: number[] = [];
  for (let i = 0; i < attribute.count; i++) {
    positions.push(attribute.getX(i), attribute.getY(i), height);
  }
  for (const ring of rings) {
    positions.push(
      ...deckWalls(toModelRing(ring, originMeters, scaleFactor), height),
    );
  }
  return positions;
}

/**
 * The bridge geometries for one feature: one slab per line part, or one slab
 * per deck footprint. A bridge line with no usable layer still floats at the
 * default height, so it reads as a bridge rather than a road at ground level.
 */
export function bridge(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const color = new THREE.Color(BRIDGE_COLOR);
  const height = bridgeHeight(f);
  const width = bridgeDeckWidth(stringProperty(f, "class"));
  const geometries: THREE.BufferGeometry[] = [];
  const g = f.geometry;

  const addLine = (line: Geojson.Position[]) => {
    const positions = deckSolid(
      toModelLine(line, originMeters, scaleFactor),
      width,
      height,
    );
    const geometry = applyGeometry(positions, color);
    if (geometry) geometries.push(geometry);
  };
  const addArea = (rings: Geojson.Position[][]) => {
    const positions = polygonDeckPositions(
      rings,
      height,
      originMeters,
      scaleFactor,
    );
    const geometry = applyGeometry(positions, color);
    if (geometry) geometries.push(geometry);
  };

  if (g.type === "LineString") addLine(g.coordinates);
  else if (g.type === "MultiLineString") g.coordinates.forEach(addLine);
  else if (g.type === "Polygon") addArea(g.coordinates);
  else if (g.type === "MultiPolygon") g.coordinates.forEach(addArea);
  else throw Error(`Cannot have a bridge of type ${g.type}`);

  return geometries;
}

/**
 * The portal geometry for one tunnel endpoint: a dark frame at the surface
 * where the tunnel meets it, oriented along the tunnel. Empty when the feature
 * is not a point (tilegen only emits portal Points).
 */
export function tunnel(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  if (f.geometry.type !== "Point") return [];
  const [lon, lat] = f.geometry.coordinates as [number, number];
  const centre = toModelCoords([lon, lat], originMeters, scaleFactor);
  const width = bridgeDeckWidth(stringProperty(f, "class"));
  const angle = numberProperty(f, "angle");
  const positions = portalSolid(
    [centre[0], centre[1]],
    Number.isFinite(angle) ? angle : 0,
    width,
  );
  const geometry = applyGeometry(positions, new THREE.Color(TUNNEL_COLOR));
  return geometry ? [geometry] : [];
}

// one shared material per kind; baked vertex colors mean a whole tile is a
// single draw call. DoubleSide because the parapets are single planes and a
// bridge is seen from either side.
export const bridgeMaterial = new THREE.MeshToonMaterial({
  vertexColors: true,
  side: THREE.DoubleSide,
});
export const tunnelMaterial = new THREE.MeshToonMaterial({
  vertexColors: true,
  side: THREE.DoubleSide,
});
