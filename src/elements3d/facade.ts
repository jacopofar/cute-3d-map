import * as THREE from "three";

import { toModelCoords, type BuildingInfo } from "../geojson_data";
import {
  BALCONY_DEPTH,
  BALCONY_RAILING,
  BALCONY_SLAB,
  DOOR_HEIGHT,
  balconyBands,
  balconyColumn,
  balconySpan,
  doorSpan,
  facadeWindows,
  floorBands,
} from "./facade_layout";
import { hashSeed, makeRng } from "./random";

// one shared material for all facade detail; like the building/tree materials it
// is a module singleton and is never disposed
export const facadeMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

// push the detail quads just off the wall so they do not z-fight the facade
const FACADE_EPS = 0.05;

// Window glass tones, picked once per building so all of its windows match:
// dark grey, light blue, dark brown, white. The balcony tones are the two
// greys, and the door is brown. Exported so tests can tell the flat wall quads
// (windows, door) from the balconies.
export const FACADE_COLORS = {
  window: [0x3c3c3c, 0x9ec7e8, 0x4a3526, 0xf2f2f2],
  door: 0x6b4a2f,
  balconySlab: 0xb5b1aa,
  balconyRail: 0x8a9096,
};

type Triple = [number, number, number];
type Point = [number, number];

// the four vertex buffers of a geometry being built
type Buffers = [number[], number[], number[], number[]];

interface Edge {
  a: Point;
  dir: Point;
  normal: Point;
  length: number;
}

// append a quad. The winding is set so the face points along `facing`: three.js
// culls back faces, and OSM rings come in both windings, so getting this wrong
// makes quads invisible from the side that matters.
function pushFace(
  buffers: Buffers,
  corners: Triple[],
  facing: Triple,
  rgb: THREE.Color,
): void {
  const [position, normal, uv, color] = buffers;
  const e1: Triple = [
    corners[1][0] - corners[0][0],
    corners[1][1] - corners[0][1],
    corners[1][2] - corners[0][2],
  ];
  const e2: Triple = [
    corners[2][0] - corners[0][0],
    corners[2][1] - corners[0][1],
    corners[2][2] - corners[0][2],
  ];
  const cross: Triple = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  const aligned =
    cross[0] * facing[0] + cross[1] * facing[1] + cross[2] * facing[2] >= 0;
  const order = aligned ? [0, 1, 2, 0, 2, 3] : [0, 3, 2, 0, 2, 1];
  for (const i of order) {
    position.push(corners[i][0], corners[i][1], corners[i][2]);
    normal.push(facing[0], facing[1], facing[2]);
    uv.push(0, 0);
    color.push(rgb.r, rgb.g, rgb.b);
  }
}

// a vertical quad standing on p0 -> p1, from z0 to z1, facing `facing`
function pushQuad(
  buffers: Buffers,
  p0: Point,
  p1: Point,
  z0: number,
  z1: number,
  facing: Point,
  rgb: THREE.Color,
): void {
  pushFace(
    buffers,
    [
      [p0[0], p0[1], z0],
      [p1[0], p1[1], z0],
      [p1[0], p1[1], z1],
      [p0[0], p0[1], z1],
    ],
    [facing[0], facing[1], 0],
    rgb,
  );
}

// the point `distance` along the edge, pushed out from the wall
function along(edge: Edge, distance: number): Point {
  return [
    edge.a[0] + edge.dir[0] * distance + edge.normal[0] * FACADE_EPS,
    edge.a[1] + edge.dir[1] * distance + edge.normal[1] * FACADE_EPS,
  ];
}

const outward = (p: Point, normal: Point, distance: number): Point => [
  p[0] + normal[0] * distance,
  p[1] + normal[1] * distance,
];

// a slab and a railing on a facade: the floor plate and a railing standing on
// its outer edge. Kept to five quads — the plate's underside and ends are never
// seen from above, so they are not worth the geometry.
function pushBalcony(
  buffers: Buffers,
  edge: Edge,
  span: { start: number; width: number },
  sill: number,
  slab: THREE.Color,
  rail: THREE.Color,
): void {
  const inner0 = along(edge, span.start);
  const inner1 = along(edge, span.start + span.width);
  const outer0 = outward(inner0, edge.normal, BALCONY_DEPTH);
  const outer1 = outward(inner1, edge.normal, BALCONY_DEPTH);
  const sideOut: Point = [-edge.dir[0], -edge.dir[1]];
  const sideIn: Point = [edge.dir[0], edge.dir[1]];
  const bottom = sill - BALCONY_SLAB;
  const railTop = sill + BALCONY_RAILING;
  const v = (p: Point, z: number): Triple => [p[0], p[1], z];

  // the plate, then the railing on its outer edge
  pushFace(
    buffers,
    [v(inner0, sill), v(outer0, sill), v(outer1, sill), v(inner1, sill)],
    [0, 0, 1],
    slab,
  );
  pushQuad(buffers, outer0, outer1, bottom, sill, edge.normal, slab);
  pushQuad(buffers, outer0, outer1, sill, railTop, edge.normal, rail);
  pushQuad(buffers, inner0, outer0, sill, railTop, sideOut, rail);
  pushQuad(buffers, inner1, outer1, sill, railTop, sideIn, rail);
}

// every edge of a ring as model-space edges with an outward normal. The normal
// side depends on the ring winding, so use the signed area to orient it.
function ringEdges(
  ring: [number, number][],
  originMeters: [number, number],
  scaleFactor: number,
): Edge[] {
  const points = ring.map((c) =>
    toModelCoords([c[0], c[1]], originMeters, scaleFactor),
  );
  if (points.length < 3) return [];
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const orient = area > 0 ? 1 : -1;
  const edges: Edge[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1) continue;
    const dir: Point = [dx / length, dy / length];
    const normal: Point = [orient * dir[1], orient * -dir[0]];
    edges.push({ a, dir, normal, length });
  }
  return edges;
}

export interface FacadeDetail {
  // flat wall quads: the windows and the door
  windows: THREE.BufferGeometry | null;
  // the slabs and railings
  balconies: THREE.BufferGeometry | null;
}

/**
 * Windows, balconies and one door for a tile's buildings, as two geometries so
 * the windows and the balconies can be switched on their own. Each carries
 * positions, normals, uvs and a baked color, so a tile draws its facade detail
 * in one call per group.
 */
export function tileFacadeDetail(
  originMeters: [number, number],
  scaleFactor: number,
  infos: BuildingInfo[],
): FacadeDetail {
  const windows: Buffers = [[], [], [], []];
  const balconies: Buffers = [[], [], [], []];
  const rgb = new THREE.Color();

  for (const info of infos) {
    const first = info.rings[0]?.[0];
    const edges: Edge[] = [];
    for (const ring of info.rings) {
      edges.push(...ringEdges(ring, originMeters, scaleFactor));
    }
    if (edges.length === 0) continue;
    // a stable seed from where the building is, so its detail never moves. A
    // separate stream for the balconies keeps them from shifting the windows.
    const seed = first ? `${first[0]},${first[1]}` : "";
    const rng = makeRng(hashSeed(seed));
    const balconyRng = makeRng(hashSeed(`${seed}:balcony`));
    const bands = floorBands(info.height, rng);
    const balconyFloors = balconyBands(bands);
    // one glass tone for the whole building
    const windowColor = new THREE.Color(
      FACADE_COLORS.window[
        hashSeed(`${seed}:window`) % FACADE_COLORS.window.length
      ],
    );
    let longest: Edge | null = null;

    for (const edge of edges) {
      if (!longest || edge.length > longest.length) longest = edge;
      for (const column of facadeWindows(edge.length, rng)) {
        // balconies are decided per column, so they stack vertically (every
        // floor above the ground) and only occasionally come out irregular
        const columnBalconies = balconyColumn(balconyFloors, balconyRng);
        for (let floor = 0; floor < bands.length; floor++) {
          const band = bands[floor];
          pushQuad(
            windows,
            along(edge, column.start),
            along(edge, column.start + column.width),
            band.start,
            band.start + band.width,
            edge.normal,
            windowColor,
          );
          if (columnBalconies.includes(floor)) {
            pushBalcony(
              balconies,
              edge,
              balconySpan(column, edge.length, balconyRng),
              band.start,
              rgb.setHex(FACADE_COLORS.balconySlab),
              rgb.setHex(FACADE_COLORS.balconyRail),
            );
          }
        }
      }
    }

    // one door, on the longest ground-floor facade
    const door =
      longest && info.height > DOOR_HEIGHT + 0.1
        ? doorSpan(longest.length)
        : null;
    if (longest && door) {
      pushQuad(
        windows,
        along(longest, door.start),
        along(longest, door.start + door.width),
        0,
        DOOR_HEIGHT,
        longest.normal,
        rgb.setHex(FACADE_COLORS.door),
      );
    }
  }

  return {
    windows: geometryFrom(windows),
    balconies: geometryFrom(balconies),
  };
}

// positions/normals/uvs/colors -> a BufferGeometry, or null when empty
function geometryFrom(buffers: number[][]): THREE.BufferGeometry | null {
  const [position, normal, uv, color] = buffers;
  if (position.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(position, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(color, 3));
  return geometry;
}
