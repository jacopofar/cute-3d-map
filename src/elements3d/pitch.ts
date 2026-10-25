import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { applyVertexColor } from "./vertex_color";
import { BoxBuilder } from "./box_builder";
import {
  pitchFrame,
  pitchPaint,
  pitchPoint,
  pitchSportOf,
  type PitchFrame,
} from "./pitch_layout";

/*
 * Sports pitches. A pitch is already a green area — tilegen emits it as
 * `cmtype: "green"` and adds its `sport` — so this only draws what the grass
 * cannot say: the surface of a court that is not grass, the painted markings,
 * and the goal frames, hoops and nets. The layout maths is `pitch_layout.ts`.
 *
 * One feature yields two kinds: `pitch` is a merged Lambert mesh (the surface
 * tint and the 3D props), `pitch_paint` the white lines. A kind cannot be a Mesh
 * and a LineSegments at once, and the paint is a lot of vertices that want the
 * cheap line material.
 */

// The surface sits just above the green plane (-0.02) and the paint above it;
// both stay under the park paths (0.03) and the lane paint (0.04).
const SURFACE_Z = 0.01;
const PAINT_Z = 0.02;

// The court colors. Grass pitches keep the lawn the green layer already draws,
// so soccer has no tint at all.
const SURFACE_COLORS: Record<string, string> = {
  tennis: "#a8503a", // clay, which is what most Italian courts are
  basketball: "#95503a", // the reddish rubber of an outdoor court
  volleyball: "#c9b085", // sand
};

const GOAL_FRAME = new THREE.Color("#f4f4ef");
const BOARD = new THREE.Color("#e9e7e0");
const RIM = new THREE.Color("#cc5530");
const POLE = new THREE.Color("#5b6169");
const NET = new THREE.Color("#dedcd4");

// The props scale with the pitch, like the paint: a 40 m five-a-side gets a
// proportionate goal rather than the full 7.32 m one.
const GOAL_WIDTH = 7.32;
const GOAL_HEIGHT = 2.44;

export const pitchMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

export const pitchPaintMaterial = new THREE.LineBasicMaterial({
  color: 0xf4f4ee,
  transparent: true,
  opacity: 0.85,
  depthWrite: false,
});

export interface PitchGeometries {
  surface: THREE.BufferGeometry[];
  paint: THREE.BufferGeometry[];
}

// the largest ring of the feature, in model space: a pitch is one rectangle
function pitchRing(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): [number, number][] | null {
  const g = f.geometry;
  const parts: Geojson.Position[][] =
    g.type === "Polygon"
      ? [g.coordinates[0]]
      : g.type === "MultiPolygon"
        ? g.coordinates.map((part) => part[0])
        : [];
  let best: Geojson.Position[] | null = null;
  let bestArea = 0;
  for (const part of parts) {
    // shoelace on the raw lon/lat: only used to rank the parts
    let twice = 0;
    for (let i = 0; i < part.length - 1; i++) {
      twice += part[i][0] * part[i + 1][1] - part[i + 1][0] * part[i][1];
    }
    const area = Math.abs(twice);
    if (area > bestArea) {
      bestArea = area;
      best = part;
    }
  }
  if (!best || best.length < 4) return null;
  return best.map((c) =>
    toModelCoords([c[0], c[1]] as [number, number], originMeters, scaleFactor),
  );
}

// the field as two triangles, in one flat color
function fieldSurface(
  frame: PitchFrame,
  color: THREE.Color,
): THREE.BufferGeometry {
  const halfLength = frame.length / 2;
  const halfWidth = frame.width / 2;
  const corners = [
    pitchPoint(frame, -halfLength, -halfWidth),
    pitchPoint(frame, halfLength, -halfWidth),
    pitchPoint(frame, halfLength, halfWidth),
    pitchPoint(frame, -halfLength, halfWidth),
  ];
  // The frame's `along`/`across` pair comes from an OSM ring, which arrives in
  // either winding, so the quad is counter-clockwise only half the time: a
  // court wound the other way faces down and is back-face culled, leaving the
  // lawn showing through its own paint. Flip the corners when that happens.
  const wound =
    (corners[1][0] - corners[0][0]) * (corners[2][1] - corners[0][1]) -
    (corners[2][0] - corners[0][0]) * (corners[1][1] - corners[0][1]);
  if (wound < 0) corners.reverse();
  const positions: number[] = [];
  for (const index of [0, 1, 2, 0, 2, 3]) {
    positions.push(corners[index][0], corners[index][1], SURFACE_Z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(
      [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      3,
    ),
  );
  geometry.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2),
  );
  applyVertexColor(geometry, color);
  return geometry;
}

// a goal at each short end: two posts and a crossbar, as tall as the field is
// big. The crossbar is the one box whose long side runs across the pitch.
function goals(frame: PitchFrame, parts: THREE.BufferGeometry[]): void {
  const scale = frame.scale;
  const angleAcross = Math.atan2(frame.across[1], frame.across[0]);
  const post = 0.12 * scale;
  const width = GOAL_WIDTH * scale;
  const height = GOAL_HEIGHT * scale;
  const boxes = new BoxBuilder();
  for (const end of [-1, 1]) {
    const u = (end * frame.length) / 2;
    for (const side of [-1, 1]) {
      const [x, y] = pitchPoint(frame, u, (side * GOAL_WIDTH) / 2);
      boxes.box(x, y, 0, post, post, height, angleAcross, GOAL_FRAME);
    }
    // the crossbar: its long side runs across the pitch, on top of the posts
    const [x, y] = pitchPoint(frame, u, 0);
    boxes.box(x, y, height - post, width, post, post, angleAcross, GOAL_FRAME);
  }
  const geometry = boxes.geometry();
  if (geometry) parts.push(geometry);
}

// a hoop at each end: pole, backboard and the rim as a small torus, which is the
// one shape that reads as a hoop from the top down
function hoops(frame: PitchFrame, parts: THREE.BufferGeometry[]): void {
  const scale = frame.scale;
  const angleAcross = Math.atan2(frame.across[1], frame.across[0]);
  const boxes = new BoxBuilder();
  for (const end of [-1, 1]) {
    const baseline = (end * frame.length) / 2;
    // the pole behind the baseline, the board 1.2 m in, the rim just inside it
    const [px, py] = pitchPoint(frame, baseline - end * 0.4, 0);
    boxes.box(
      px,
      py,
      0,
      0.16 * scale,
      0.16 * scale,
      3.3 * scale,
      angleAcross,
      POLE,
    );
    const [bx, by] = pitchPoint(frame, baseline - end * 1.2, 0);
    boxes.box(
      bx,
      by,
      2.9 * scale,
      1.8 * scale,
      0.06 * scale,
      1.05 * scale,
      angleAcross,
      BOARD,
    );
    const [rx, ry] = pitchPoint(frame, baseline - end * 1.575, 0);
    const rim = new THREE.TorusGeometry(0.23 * scale, 0.025 * scale, 4, 12);
    rim.rotateX(Math.PI / 2);
    rim.translate(rx, ry, 3.05 * scale);
    applyVertexColor(rim, RIM);
    parts.push(rim.toNonIndexed());
    rim.dispose();
  }
  const geometry = boxes.geometry();
  if (geometry) parts.push(geometry);
}

// a net across the middle: two posts and a band. Tennis and volleyball differ
// only in the height of the posts and where the band hangs.
function net(
  frame: PitchFrame,
  parts: THREE.BufferGeometry[],
  postHeight: number,
  bandBottom: number,
  bandHeight: number,
): void {
  const scale = frame.scale;
  const angleAcross = Math.atan2(frame.across[1], frame.across[0]);
  const halfWidth = frame.width / 2;
  const boxes = new BoxBuilder();
  for (const side of [-1, 1]) {
    const [x, y] = pitchPoint(frame, 0, side * halfWidth);
    boxes.box(
      x,
      y,
      0,
      0.09 * scale,
      0.09 * scale,
      postHeight * scale,
      angleAcross,
      POLE,
    );
  }
  const [x, y] = pitchPoint(frame, 0, 0);
  boxes.box(
    x,
    y,
    bandBottom * scale,
    frame.width * scale,
    0.04 * scale,
    bandHeight * scale,
    angleAcross,
    NET,
  );
  const geometry = boxes.geometry();
  if (geometry) parts.push(geometry);
}

/**
 * The pitch geometry of one feature: the court surface and its props in one
 * mesh, the markings in one LineSegments. Both empty for a green that is not a
 * pitch, or a sport this pass has no layout for (a rugby or hockey pitch keeps
 * the plain green it already had).
 */
export function pitch(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): PitchGeometries {
  const props = f.properties as { sport?: unknown } | null;
  const sport = pitchSportOf(props?.sport);
  if (!sport) return { surface: [], paint: [] };
  const ring = pitchRing(originMeters, scaleFactor, f);
  if (!ring) return { surface: [], paint: [] };
  const frame = pitchFrame(ring, sport);
  if (!frame) return { surface: [], paint: [] };

  const parts: THREE.BufferGeometry[] = [];
  const tint = SURFACE_COLORS[sport];
  if (tint) parts.push(fieldSurface(frame, new THREE.Color(tint)));
  if (sport === "soccer") goals(frame, parts);
  if (sport === "basketball") hoops(frame, parts);
  if (sport === "tennis") net(frame, parts, 1.07, 0.1, 0.95);
  if (sport === "volleyball") net(frame, parts, 2.55, 1.9, 1.0);

  const segments = pitchPaint(sport, frame);
  const positions: number[] = [];
  for (const { a, b } of segments) {
    positions.push(a[0], a[1], PAINT_Z, b[0], b[1], PAINT_Z);
  }
  const paint = new THREE.BufferGeometry();
  paint.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );

  // the per-tile pass merges what a kind holds, so the parts can stay separate
  return { surface: parts, paint: positions.length > 0 ? [paint] : [] };
}
