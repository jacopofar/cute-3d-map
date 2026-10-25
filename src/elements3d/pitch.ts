import * as THREE from "three";
import type Geojson from "geojson";

import {
  epsg3857toEpsg4326,
  epsg4326toEpsg3857,
  toModelCoords,
} from "../projection";
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

// What the `surface` tag says about the colour: `known` false means the tag is
// absent or says nothing about colour, so the sport's guess applies.
function surfaceTint(surface: unknown): {
  known: boolean;
  color: string | null;
} {
  if (typeof surface !== "string") return { known: false, color: null };
  for (const part of surface.split(";")) {
    const tag = part.trim().toLowerCase();
    const color = SURFACE_BY_TAG[tag];
    if (color) return { known: true, color };
    if (PLAIN_SURFACE.has(tag)) return { known: true, color: null };
  }
  return { known: false, color: null };
}

// The surface sits just above the green plane (-0.02) and the paint above it;
// both stay under the park paths (0.03) and the lane paint (0.04).
const SURFACE_Z = 0.01;
const PAINT_Z = 0.02;

// The court colors. Grass pitches keep the lawn the green layer already draws,
// so soccer has no tint at all.
const SURFACE_COLORS: Record<string, string> = {
  tennis: "#a8503a", // clay, which is what most Italian courts are
  padel: "#3f6b85", // the blue turf of a padel box
  basketball: "#95503a", // the reddish rubber of an outdoor court
  multi: "#95503a", // a multi-use court is a ball court: same rubber
  volleyball: "#c9b085", // sand
  beachvolleyball: "#c9b085",
  athletics: "#9c4128", // tartan
};

// The mapped `surface` beats the sport's guess: a basketball court tagged
// concrete is gray, not the reddish rubber most outdoor courts are, and a hard
// tennis court is not clay. Only a quarter of the pitches tag it, so the sport
// table above stays the default.
const SURFACE_BY_TAG: Record<string, string> = {
  clay: "#a8503a",
  ground: "#8a6a4a", // dirt
  earth: "#8a6a4a",
  gravel: "#8f8a7c",
  concrete: "#8d8a84",
  asphalt: "#6c6f72",
  paving_stones: "#8d8a84",
  tartan: "#9c4128",
  rubber: "#95503a",
  acrylic: "#3f6b85",
  hard: "#3f6b85",
  sand: "#c9b085",
};

// a surface that is ground already: the green layer's lawn is the right colour,
// so the tag removes the sport's tint instead of replacing it
const PLAIN_SURFACE = new Set([
  "grass",
  "artificial_turf",
  "turf",
  "synthetic",
]);

const GOAL_FRAME = new THREE.Color("#f4f4ef");
const BOARD = new THREE.Color("#e9e7e0");
const RIM = new THREE.Color("#cc5530");
const POLE = new THREE.Color("#5b6169");
const NET = new THREE.Color("#dedcd4");

// Width and height of the goal frame, in field meters. The props scale with the
// pitch, like the paint, so a futsal pitch gets its own 3 m goal rather than a
// shrunken 7.32 m one.
const GOALS: Record<string, [number, number]> = {
  soccer: [7.32, 2.44],
  futsal: [3, 2],
  "five-a-side": [3, 2],
  // rugby's H: 5.6 m between the posts, the crossbar at 3 m
  rugby: [5.6, 3],
  rugby_union: [5.6, 3],
  rugby_league: [5.6, 3],
};

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

interface PitchRings {
  // the part the layout is fitted to: a pitch is one rectangle, a track the
  // oval that carries the lanes
  outer: [number, number][];
  // the infield of a track, which the tartan does not cover
  holes: [number, number][][];
}

// the largest part of the feature, in model space
function pitchRings(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): PitchRings | null {
  const g = f.geometry;
  const parts: Geojson.Position[][][] =
    g.type === "Polygon"
      ? [g.coordinates]
      : g.type === "MultiPolygon"
        ? g.coordinates
        : [];
  let best: Geojson.Position[][] | null = null;
  let bestArea = 0;
  for (const part of parts) {
    // shoelace on the raw lon/lat: only used to rank the parts
    const ring = part[0];
    let twice = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      twice += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    const area = Math.abs(twice);
    if (area > bestArea) {
      bestArea = area;
      best = part;
    }
  }
  if (!best || best[0].length < 4) return null;
  const toModel = (ring: Geojson.Position[]) =>
    ring.map((c) =>
      toModelCoords(
        [c[0], c[1]] as [number, number],
        originMeters,
        scaleFactor,
      ),
    );
  return {
    outer: toModel(best[0]),
    holes: best.slice(1).map(toModel),
  };
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
function goals(
  frame: PitchFrame,
  parts: THREE.BufferGeometry[],
  [goalWidth, goalHeight]: [number, number],
): void {
  const scale = frame.scale;
  const angleAcross = Math.atan2(frame.across[1], frame.across[0]);
  const post = 0.12 * scale;
  const width = goalWidth * scale;
  const height = goalHeight * scale;
  const boxes = new BoxBuilder();
  for (const end of [-1, 1]) {
    const u = (end * frame.length) / 2;
    for (const side of [-1, 1]) {
      const [x, y] = pitchPoint(frame, u, (side * goalWidth) / 2);
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

// The ring itself, filled: a track's tartan is an oval with the infield cut out,
// so it cannot be the fitted rectangle the courts use.
function ringSurface(
  rings: PitchRings,
  color: THREE.Color,
): THREE.BufferGeometry | null {
  const toVec = (point: [number, number]) => new THREE.Vector2(...point);
  const shape = new THREE.Shape(rings.outer.map(toVec));
  for (const hole of rings.holes)
    shape.holes.push(new THREE.Path(hole.map(toVec)));
  const flat = new THREE.ShapeGeometry(shape);
  const geometry = flat.index ? flat.toNonIndexed() : flat;
  if (geometry !== flat) flat.dispose();
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i++) position.setZ(i, SURFACE_Z);
  applyVertexColor(geometry, color);
  return position.count >= 3 ? geometry : null;
}

// Sports whose ground is big enough to be floodlit with corner masts. The paint
// is a frontend pass, so the masts are too: no tile data, no rebuild.
const LIT_SPORTS = new Set([
  "soccer",
  "rugby",
  "rugby_union",
  "rugby_league",
  "athletics",
]);

// a mown field under 60 m is a training area, not a floodlit ground
const MIN_LIT_LENGTH = 60;

// the masts stand a couple of meters outside the touchline
const MAST_INSET = 2.5;

/**
 * The four floodlight masts of a pitch, as lon/lat, for the night lights. Empty
 * for the sports and the sizes that have none. The layout works in meters, so
 * the ring is projected first and the masts are projected back. The layout works in
 * meters, so the ring is projected first and the masts are projected back.
 */
export function pitchFloodlights(
  sport: unknown,
  rings: readonly (readonly [number, number][])[] | undefined,
): [number, number][] {
  const kind = pitchSportOf(sport);
  if (!kind || !LIT_SPORTS.has(kind)) return [];
  const ring = rings?.[0];
  if (!ring || ring.length < 4) return [];
  const meters = ring.map((point) => epsg4326toEpsg3857([point[0], point[1]]));
  // metres with a scale of 1 is the same frame the geometry uses
  const frame = pitchFrame(meters, kind);
  if (!frame || frame.length * frame.scale < MIN_LIT_LENGTH) return [];
  const halfLength = frame.length / 2 + MAST_INSET;
  const halfWidth = frame.width / 2 + MAST_INSET;
  const masts: [number, number][] = [];
  for (const along of [-1, 1]) {
    for (const across of [-1, 1]) {
      masts.push(
        epsg3857toEpsg4326(
          pitchPoint(frame, along * halfLength, across * halfWidth),
        ),
      );
    }
  }
  return masts;
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
  const props = f.properties as { sport?: unknown; surface?: unknown } | null;
  const sport = pitchSportOf(props?.sport);
  if (!sport) return { surface: [], paint: [] };
  const rings = pitchRings(originMeters, scaleFactor, f);
  if (!rings) return { surface: [], paint: [] };
  const frame = pitchFrame(rings.outer, sport);
  if (!frame) return { surface: [], paint: [] };

  const parts: THREE.BufferGeometry[] = [];
  const mapped = surfaceTint(props?.surface);
  const tint = mapped.known ? mapped.color : (SURFACE_COLORS[sport] ?? null);
  if (tint) {
    const surface =
      sport === "athletics"
        ? ringSurface(rings, new THREE.Color(tint))
        : fieldSurface(frame, new THREE.Color(tint));
    if (surface) parts.push(surface);
  }
  const goal = GOALS[sport];
  if (goal) goals(frame, parts, goal);
  if (sport === "basketball" || sport === "multi") hoops(frame, parts);
  if (sport === "tennis") net(frame, parts, 1.07, 0.1, 0.95);
  if (sport === "volleyball" || sport === "beachvolleyball")
    net(frame, parts, 2.55, 1.9, 1.0);

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
