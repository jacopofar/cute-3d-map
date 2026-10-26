import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { MeshBuilder } from "./mesh_builder";
import { pointInRing } from "./tombstone_rows";
import { hashSeed } from "./random";

/*
 * Construction sites: a dirt/gravel ground polygon with tower cranes, material
 * stacks and containers. tilegen clips the `landuse=construction` area to the
 * tile; only the tile holding the site centroid carries the `crane` flag, so a
 * site spanning several tiles does not sprout a crane in every one.
 *
 * Cranes are simplified solid masts/jibs rather than lattice towers: at map
 * zoom the silhouette is the point, and a lattice would cost many triangles for
 * no readable difference. No shadows.
 */

const DIRT_DARK = new THREE.Color("#cdb391");
const CRANE = new THREE.Color("#f0b429");
const CRANE_DARK = new THREE.Color("#4a4a44");
const CONCRETE = new THREE.Color("#9a9488");
const CONTAINER_COLORS = [
  new THREE.Color("#3f6b8a"),
  new THREE.Color("#8a4a3a"),
  new THREE.Color("#4a7a4a"),
  new THREE.Color("#b08a3a"),
];

export const constructionMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

type Point = [number, number];

export interface ConstructionInfo {
  id?: string;
  name?: string;
  kind?: string;
  lon: number;
  lat: number;
  rings: Point[][];
}

function centroid(ring: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const [px, py] of ring) {
    x += px;
    y += py;
  }
  return [x / ring.length, y / ring.length];
}

function inside(rings: Point[][], x: number, y: number): boolean {
  if (!pointInRing(x, y, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    if (pointInRing(x, y, rings[h])) return false;
  }
  return true;
}

/** Anchor points near the site edges, one per crane. OSM construction areas
 * often wrap existing buildings, so a crane at the centroid can rise out of a
 * roof; the midpoint of the longest edges (nudged inward) sits on the open
 * margin instead. Falls back to an interior point when that fails. */
function siteAnchors(rings: Point[][], inset: number, count: number): Point[] {
  const [cx, cy] = centroid(rings[0]);
  const candidates: { length: number; point: Point }[] = [];
  const ring = rings[0];
  for (let i = 0; i + 1 < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const dx = cx - mx;
    const dy = cy - my;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const point: Point = [
      mx + (dx / length) * inset,
      my + (dy / length) * inset,
    ];
    if (!inside(rings, point[0], point[1])) continue;
    candidates.push({ length: Math.hypot(bx - ax, by - ay), point });
  }
  candidates.sort((a, b) => b.length - a.length);
  const anchors: Point[] = [];
  for (const candidate of candidates) {
    if (anchors.length >= count) break;
    if (
      anchors.some(
        ([x, y]) =>
          Math.hypot(candidate.point[0] - x, candidate.point[1] - y) <
          inset * 2,
      )
    ) {
      continue;
    }
    anchors.push(candidate.point);
  }
  while (anchors.length < count) {
    const fallback = interiorPoint(rings);
    if (
      anchors.some(([x, y]) => Math.hypot(fallback[0] - x, fallback[1] - y) < 8)
    )
      break;
    anchors.push(fallback);
  }
  return anchors;
}

/** A point guaranteed inside the site, for a fallback anchor. The arithmetic
 * centroid of a concave ring can sit outside it, so fall back to a grid scan
 * over its bounding box. */
function interiorPoint(rings: Point[][]): Point {
  const [cx, cy] = centroid(rings[0]);
  if (inside(rings, cx, cy)) return [cx, cy];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of rings[0]) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  for (let ix = 1; ix < 10; ix++) {
    for (let iy = 1; iy < 10; iy++) {
      const x = minX + ((maxX - minX) * ix) / 10;
      const y = minY + ((maxY - minY) * iy) / 10;
      if (inside(rings, x, y)) return [x, y];
    }
  }
  return rings[0][0];
}

function crane(
  cx: number,
  cy: number,
  angle: number,
  height: number,
  jib: number,
): THREE.BufferGeometry | null {
  const b = new MeshBuilder();
  b.box(0, 0, 0, 2.2, 2.2, 0.8, 0, CONCRETE);
  b.box(0, 0, 0.8, 0.9, 0.9, height, 0, CRANE);
  // jib and counter-jib along local y
  b.box(0, jib / 2, height - 0.35, 0.8, jib, 0.8, 0, CRANE);
  b.box(0, -jib * 0.22, height - 0.35, 0.8, jib * 0.44, 0.8, 0, CRANE);
  b.box(0, -jib * 0.46, height - 1.1, 1.6, 1.6, 1.1, 0, CRANE_DARK);
  b.box(0, 0.9, height - 1.5, 1.5, 1.3, 1.2, 0, CRANE_DARK);
  // hook cable and hook at the jib tip
  b.box(
    0,
    jib * 0.47,
    height - height * 0.45,
    0.08,
    0.08,
    height * 0.45,
    0,
    CRANE_DARK,
  );
  b.box(
    0,
    jib * 0.47,
    height - height * 0.45 - 0.4,
    0.5,
    0.5,
    0.4,
    0,
    CRANE_DARK,
  );
  const geometry = b.geometry();
  if (!geometry) return null;
  geometry.rotateZ(angle);
  geometry.translate(cx, cy, 0);
  return geometry;
}

function siteProps(
  parts: THREE.BufferGeometry[],
  x: number,
  y: number,
  seed: number,
): void {
  const b = new MeshBuilder();
  // two containers and a low material stack
  b.box(x, y, 0, 2.4, 1.2, 1.2, 0, CONTAINER_COLORS[seed % 4]);
  b.box(
    x + 1.6,
    y - 0.4,
    0,
    2.4,
    1.2,
    1.2,
    Math.PI / 2,
    CONTAINER_COLORS[(seed + 1) % 4],
  );
  b.box(x - 1.4, y + 1.1, 0, 2.2, 1.6, 0.6, 0, CONCRETE);
  const geometry = b.geometry();
  if (geometry) parts.push(geometry);
}

function ground(
  rings: Point[][],
  color: THREE.Color,
): THREE.BufferGeometry | null {
  const shape = new THREE.Shape(
    rings[0].map(([x, y]) => new THREE.Vector2(x, y)),
  );
  for (let h = 1; h < rings.length; h++) {
    shape.holes.push(
      new THREE.Path(rings[h].map(([x, y]) => new THREE.Vector2(x, y))),
    );
  }
  const geometry = new THREE.ShapeGeometry(shape);
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = flat.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  // move the flat ground a little above the basemap
  flat.translate(0, 0, 0.02);
  geometry.dispose();
  return flat;
}

/** The geometry for one clipped construction site, or empty. */
export function construction(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const geometry = f.geometry;
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
    throw Error(`Cannot have construction of type ${geometry.type}`);
  }
  const props = f.properties as {
    crane?: unknown;
    site_area?: unknown;
  } | null;
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const out: THREE.BufferGeometry[] = [];

  for (const polygon of polygons) {
    const rings: Point[][] = polygon.map((ring) =>
      ring.map(([lon, lat]) =>
        toModelCoords([lon, lat], originMeters, scaleFactor),
      ),
    );
    if (rings.length === 0 || rings[0].length < 3) continue;
    const seed = hashSeed(`${f.id}`);
    const parts: THREE.BufferGeometry[] = [];
    const dirt = ground(rings, DIRT_DARK);
    if (!dirt) continue;
    parts.push(dirt);

    if (props?.crane === true) {
      const area = Number(props.site_area) || 0;
      const count = area > 30000 ? 3 : area > 8000 ? 2 : 1;
      const anchors = siteAnchors(rings, 4, count);
      for (let i = 0; i < anchors.length; i++) {
        const [x, y] = anchors[i];
        const craneHeight = 34 + ((seed + i * 7) % 12);
        const jib = 20 + ((seed + i * 5) % 8);
        const built = crane(
          x,
          y,
          ((seed * 0.37 + i * 1.9) % Math.PI) - Math.PI / 2,
          craneHeight,
          jib,
        );
        if (built) parts.push(built);
        if (i === 0) siteProps(parts, x + 2.6, y - 2.0, seed);
      }
    }

    const merged = BufferGeometryUtils.mergeGeometries(parts);
    for (const part of parts) part.dispose();
    if (merged) out.push(merged);
  }
  return out;
}

/** The construction sites in a tile, for click-picking. */
export function constructionInfo(f: Geojson.Feature): ConstructionInfo | null {
  const props = f.properties ?? {};
  const geom = f.geometry;
  const rings: Point[][] = [];
  if (geom.type === "Polygon") {
    rings.push(geom.coordinates[0] as Point[]);
  } else if (geom.type === "MultiPolygon") {
    for (const polygon of geom.coordinates) {
      rings.push(polygon[0] as Point[]);
    }
  } else {
    return null;
  }
  if (rings.length === 0) return null;
  return {
    id: typeof f.id === "string" ? f.id : undefined,
    name: typeof props.name === "string" ? props.name : undefined,
    kind:
      typeof props.construction === "string" ? props.construction : undefined,
    ...(() => {
      const [lon, lat] = siteAnchors(rings, 4 / 111_000, 1)[0];
      return { lon, lat };
    })(),
    rings,
  };
}
