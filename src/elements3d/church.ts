import * as THREE from "three";

import { toModelCoords, type BuildingInfo } from "../geojson_data";
import { hashSeed, makeRng } from "./random";
import {
  frameToWorld,
  ridgeAxis,
  roofKind,
  roofOutline,
  roofPlan,
} from "./roof_layout";

// OSM `building` values that are a church. The classification lives here, in
// the frontend: tilegen only reports the tag.
export const CHURCH_BUILDINGS = new Set([
  "church",
  "cathedral",
  "chapel",
  "basilica",
  "abbey",
  "monastery",
]);

export interface ChurchTags {
  building?: string;
  religion?: string;
}

/**
 * Whether a building should be given the church look (warm stone walls, a
 * steeper gabled roof, a cross on the ridge). tilegen emits `religion` only for
 * a `place_of_worship`, so a religion is enough to call it one, and
 * `christian:catholic` and friends count as Christian.
 */
export function isChurch(props: ChurchTags | undefined | null): boolean {
  if (!props) return false;
  const building = (props.building ?? "").trim().toLowerCase();
  if (CHURCH_BUILDINGS.has(building)) return true;
  return (props.religion ?? "").trim().toLowerCase().startsWith("christian");
}

// warm stone and ochre plaster, the tones of Milan's Romanesque churches: the
// point of the palette is that a church stands out from the imputed pinks and
// greys of the apartment blocks around it
export const CHURCH_WALL_COLORS = [
  "#d8c8a4",
  "#cbb78d",
  "#e2d5b6",
  "#c2a97e",
  "#cdb894",
  "#dcc9a2",
];

// slate: a church roof reads darker than the imputed terracotta around it.
// Kept mid-toned rather than near black, so the gold cross reads against it.
export const CHURCH_ROOF_COLORS = ["#5c6673", "#69737f", "#545e6a"];

// gold, so the small cross catches the light against the slate
export const CHURCH_CROSS_COLOR = "#f0d471";

// Churches are pitched steeper than the default 0.45 * width; shared with
// building.ts so the cross lands exactly on the ridge the roof built.
export const CHURCH_PITCH = 1.3;
// the shape forced on a church roof, when its footprint allows a pitched one
export const CHURCH_ROOF_SHAPE = "gabled";

// the cross: an upright this tall above the ridge, with a shorter crossbar in
// its upper third. Deliberately a little larger than life (2-3 m is what a
// parish church carries) so it still reads at the zoom the tiles are built for.
export const CROSS_HEIGHT = 3;
export const CROSS_ARM = 1.8;
const BAR = 0.3;
const CROSSBAR_AT = 0.72;
// A cross grows with the church it stands on: a 3 m cross would be a speck on a
// 100 m cathedral, and 6 m is still a plausible roof cross. Capped at double so
// the ornament never turns into a monument of its own.
export function crossScale(area: number): number {
  return Math.min(2, Math.max(1, Math.sqrt(Math.max(area, 0)) / 18));
}
// a flat roof (a courtyard, a concave outline) has no ridge to stand on, so the
// cross is lifted just clear of the cap (the extrusion has no real parapet)
export const PARAPET_HEIGHT = 0.25;

// the seeded tone a palette is sampled from. `anchor` is the building's first
// footprint coordinate (building.ts and the facade detail both seed from the
// same one), so the tone survives reloads and origin resets.
function seededColor(anchor: string, palette: string[], stream: string) {
  const rng = makeRng(hashSeed(`church:${stream}:${anchor}`));
  return palette[Math.floor(rng() * palette.length)];
}

export const churchWallColor = (anchor: string): string =>
  seededColor(anchor, CHURCH_WALL_COLORS, "wall");

export const churchRoofColor = (anchor: string): string =>
  seededColor(anchor, CHURCH_ROOF_COLORS, "roof");

type Triple = [number, number, number];
type Point = [number, number];

interface Buffers {
  position: number[];
  normal: number[];
  uv: number[];
  color: number[];
}

// append a quad, ordered so its two triangles face along `facing`. Three.js
// culls back faces, and the corner order of a box face is easy to get wrong, so
// take the winding from the cross product the way the facade quads do.
function pushQuad(
  buffers: Buffers,
  corners: Triple[],
  facing: Triple,
  rgb: THREE.Color,
): void {
  const [a, b, c] = corners;
  const e1: Triple = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2: Triple = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross: Triple = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  const aligned =
    cross[0] * facing[0] + cross[1] * facing[1] + cross[2] * facing[2] >= 0;
  const order = aligned ? [0, 1, 2, 0, 2, 3] : [0, 3, 2, 0, 2, 1];
  for (const i of order) {
    buffers.position.push(corners[i][0], corners[i][1], corners[i][2]);
    buffers.normal.push(facing[0], facing[1], facing[2]);
    buffers.uv.push(0, 0);
    buffers.color.push(rgb.r, rgb.g, rgb.b);
  }
}

// a box with its in-plane axes given by `u` (along the ridge, so the cross arms
// follow it) and `v`, half extents per axis, centred on `centre`
function pushBox(
  buffers: Buffers,
  centre: Triple,
  u: Point,
  v: Point,
  hu: number,
  hv: number,
  hz: number,
  rgb: THREE.Color,
): void {
  const at = (su: number, sv: number, sz: number): Triple => [
    centre[0] + u[0] * su * hu + v[0] * sv * hv,
    centre[1] + u[1] * su * hu + v[1] * sv * hv,
    centre[2] + sz * hz,
  ];
  const face = (corners: Triple[], local: Triple) =>
    pushQuad(
      buffers,
      corners,
      [
        u[0] * local[0] + v[0] * local[1],
        u[1] * local[0] + v[1] * local[1],
        local[2],
      ],
      rgb,
    );
  face(
    [at(-1, -1, -1), at(1, -1, -1), at(1, 1, -1), at(-1, 1, -1)],
    [0, 0, -1],
  );
  face([at(-1, -1, 1), at(1, -1, 1), at(1, 1, 1), at(-1, 1, 1)], [0, 0, 1]);
  face([at(1, -1, -1), at(1, 1, -1), at(1, 1, 1), at(1, -1, 1)], [1, 0, 0]);
  face(
    [at(-1, -1, -1), at(-1, 1, -1), at(-1, 1, 1), at(-1, -1, 1)],
    [-1, 0, 0],
  );
  face([at(-1, 1, -1), at(1, 1, -1), at(1, 1, 1), at(-1, 1, 1)], [0, 1, 0]);
  face(
    [at(-1, -1, -1), at(1, -1, -1), at(1, -1, 1), at(-1, -1, 1)],
    [0, -1, 0],
  );
}

// the upright and the crossbar, as one geometry with the walls' attributes
function crossGeometry(
  at: Point,
  axis: Point,
  baseZ: number,
  size: number,
  rgb: THREE.Color,
): THREE.BufferGeometry {
  const u: Point = [axis[0], axis[1]];
  const v: Point = [-axis[1], axis[0]];
  const height = CROSS_HEIGHT * size;
  const arm = CROSS_ARM * size;
  const half = (BAR * size) / 2;
  const buffers: Buffers = { position: [], normal: [], uv: [], color: [] };
  pushBox(
    buffers,
    [at[0], at[1], baseZ + height / 2],
    u,
    v,
    half,
    half,
    height / 2,
    rgb,
  );
  pushBox(
    buffers,
    [at[0], at[1], baseZ + height * CROSSBAR_AT],
    u,
    v,
    arm / 2,
    half,
    half,
    rgb,
  );
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

// signed area in model meters: only the comparison matters, not the sign
function ringArea(ring: Point[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) / 2;
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

/**
 * The church ornament of one building: a cross standing on the ridge (or just
 * above the cap of a flat roof), as a geometry carrying the same
 * position/normal/uv/color set as the walls, so a tile merges all of its
 * crosses into one mesh. The apex comes from the same roof plan roof.ts builds,
 * with the same pitch, so the cross sits on the ridge instead of floating or
 * sinking into it.
 */
export function church(
  originMeters: [number, number],
  scaleFactor: number,
  info: BuildingInfo,
): THREE.BufferGeometry[] {
  // a MultiPolygon church carries its cross on the largest part, the one that
  // is the body rather than a side chapel or a sacristy
  let best: Point[] | null = null;
  let bestArea = -1;
  for (const ring of info.rings) {
    if (ring.length < 3) continue;
    const points = ring.map((c) =>
      toModelCoords([c[0], c[1]], originMeters, scaleFactor),
    );
    const area = ringArea(points);
    if (area > bestArea) {
      bestArea = area;
      best = points;
    }
  }
  if (!best) return [];

  const outline = roofOutline(best);
  const plan = outline
    ? roofPlan(outline, roofKind(CHURCH_ROOF_SHAPE), CHURCH_PITCH)
    : null;
  const at = plan
    ? frameToWorld(
        plan.frame,
        (plan.ridgeMin + plan.ridgeMax) / 2,
        plan.frame.acrossCentre,
      )
    : centroid(best);
  const baseZ = info.height + (plan ? plan.rise : PARAPET_HEIGHT);
  // the arms follow the ridge: seen from the side of the church the cross reads
  // as a cross, not as a bare upright
  const axis = plan ? plan.frame.axis : ridgeAxis(best);
  return [
    crossGeometry(
      at,
      axis,
      baseZ,
      crossScale(bestArea),
      new THREE.Color(CHURCH_CROSS_COLOR),
    ),
  ];
}
