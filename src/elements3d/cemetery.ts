import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../geojson_data";
import { hashSeed } from "./random";
import { tombstoneSpots } from "./tombstone_rows";

/*
 * Cemeteries: rows of simple tombstones over the basemap.
 *
 * tilegen clips the `landuse=cemetery` area to the tile and emits it as its own
 * kind. OSM rarely maps the individual graves, so the rows are procedural
 * (tombstone_rows.ts): aligned to the longest wall, inset from the boundary and
 * capped so a large cemetery does not turn one tile into a million triangles.
 *
 * The cemetery polygon is only the layout region: there is no 3D ground on
 * purpose, so the basemap's cemetery paths and lawns remain visible under the
 * rows. The stones are one merged geometry per feature, one Lambert material
 * per tile, and do not cast shadows.
 */

type Point = [number, number];
type Triple = [number, number, number];

// mid-gray stone: the basemap cemetery is a pale beige, so white marble would
// disappear into it; a few pale stones keep the rows from looking uniform
const STONE_COLORS = [
  "#8d877a",
  "#a39d8f",
  "#777165",
  "#b9b3a4",
  "#6b665c",
  "#c9c4b6",
];
const CROSS_COLOR = new THREE.Color("#ded8c8");

export const MAX_TOMBSTONES_PER_TILE = 9000;

// a small cap per slab/cross, in triangles: the point is the silhouette, not a
// modelled headstone, because there can be thousands of them
const SLAB_WIDTH = 1.1;
const SLAB_DEPTH = 0.32;
const SLAB_HEIGHT = 1.35;

export const cemeteryMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

function hashPoint(point: Point): number {
  return hashSeed(`${point[0].toFixed(6)},${point[1].toFixed(6)}`);
}

interface Buffers {
  position: number[];
  normal: number[];
  uv: number[];
  color: number[];
}

function pushVertex(
  buffers: Buffers,
  p: Triple,
  n: Triple,
  uv: [number, number],
  color: THREE.Color,
): void {
  buffers.position.push(p[0], p[1], p[2]);
  buffers.normal.push(n[0], n[1], n[2]);
  buffers.uv.push(uv[0], uv[1]);
  buffers.color.push(color.r, color.g, color.b);
}

function pushQuad(
  buffers: Buffers,
  a: Triple,
  b: Triple,
  c: Triple,
  d: Triple,
  normal: Triple,
  color: THREE.Color,
): void {
  const e1: Triple = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2: Triple = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross: Triple = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  if (cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2] < 0) {
    [b, d] = [d, b];
  }
  pushVertex(buffers, a, normal, [0, 0], color);
  pushVertex(buffers, b, normal, [1, 0], color);
  pushVertex(buffers, c, normal, [1, 1], color);
  pushVertex(buffers, a, normal, [0, 0], color);
  pushVertex(buffers, c, normal, [1, 1], color);
  pushVertex(buffers, d, normal, [0, 1], color);
}

function pushBox(
  buffers: Buffers,
  cx: number,
  cy: number,
  baseZ: number,
  width: number,
  depth: number,
  height: number,
  angle: number,
  color: THREE.Color,
): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const hx = width / 2;
  const hy = depth / 2;
  const hz = height / 2;
  const corner = (x: number, y: number, z: number): Triple => [
    cx + x * c - y * s,
    cy + x * s + y * c,
    baseZ + hz + z,
  ];
  const p000 = corner(-hx, -hy, -hz);
  const p100 = corner(hx, -hy, -hz);
  const p110 = corner(hx, hy, -hz);
  const p010 = corner(-hx, hy, -hz);
  const p001 = corner(-hx, -hy, hz);
  const p101 = corner(hx, -hy, hz);
  const p111 = corner(hx, hy, hz);
  const p011 = corner(-hx, hy, hz);
  const nx = c;
  const ny = s;
  // normals rotate with the box; the top/bottom stay on z
  pushQuad(buffers, p000, p010, p110, p100, [0, 0, -1], color);
  pushQuad(buffers, p001, p011, p111, p101, [0, 0, 1], color);
  pushQuad(buffers, p000, p001, p101, p100, [ny, -nx, 0], color);
  pushQuad(buffers, p010, p110, p111, p011, [-ny, nx, 0], color);
  pushQuad(buffers, p000, p010, p011, p001, [-nx, -ny, 0], color);
  pushQuad(buffers, p100, p101, p111, p110, [nx, ny, 0], color);
}

function geometryFrom(buffers: Buffers): THREE.BufferGeometry | null {
  if (buffers.position.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(buffers.position, 3),
  );
  geometry.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(buffers.normal, 3),
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(buffers.uv, 2));
  geometry.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(buffers.color, 3),
  );
  return geometry;
}

function polygonOf(
  geometry: Geojson.Polygon | Geojson.MultiPolygon,
): Geojson.Position[][][] {
  return geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.coordinates;
}

/**
 * The cemetery geometries for one feature: a clipped polygon part per ground
 * piece, with its tombstones. Empty when the feature has no usable area.
 */
export function cemetery(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const geometry = f.geometry;
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
    throw Error(`Cannot have cemetery of type ${geometry.type}`);
  }
  const seed = hashSeed(`${f.id}`);
  const out: THREE.BufferGeometry[] = [];
  let budget = MAX_TOMBSTONES_PER_TILE;
  for (const polygon of polygonOf(geometry)) {
    const rings: Point[][] = polygon.map((ring) =>
      ring.map(([lon, lat]) =>
        toModelCoords([lon, lat], originMeters, scaleFactor),
      ),
    );
    if (rings.length === 0 || rings[0].length < 3) continue;
    const rng = (seed + hashPoint(rings[0][0])) >>> 0;
    const buffers: Buffers = { position: [], normal: [], uv: [], color: [] };

    const spots =
      budget > 0
        ? tombstoneSpots(rings, {
            seed: rng,
            maxStones: budget,
          })
        : [];
    for (const spot of spots) {
      const stone = new THREE.Color(
        STONE_COLORS[spot.kind % STONE_COLORS.length],
      );
      if (spot.kind === 0) {
        // a cross: a slim upright and a shorter bar, on a low plinth
        pushBox(
          buffers,
          spot.x,
          spot.y,
          0.03,
          0.78,
          0.32,
          0.18,
          spot.angle,
          stone,
        );
        pushBox(
          buffers,
          spot.x,
          spot.y,
          0.19,
          0.16,
          0.16,
          1.15,
          spot.angle,
          CROSS_COLOR,
        );
        pushBox(
          buffers,
          spot.x,
          spot.y,
          0.78,
          0.62,
          0.16,
          0.14,
          spot.angle,
          CROSS_COLOR,
        );
      } else {
        const height = SLAB_HEIGHT + ((spot.kind % 5) - 2) * 0.04;
        pushBox(
          buffers,
          spot.x,
          spot.y,
          0.03,
          SLAB_WIDTH,
          SLAB_DEPTH,
          height,
          spot.angle,
          stone,
        );
      }
    }
    budget -= spots.length;
    const built = geometryFrom(buffers);
    if (built) out.push(built);
  }
  return out;
}
