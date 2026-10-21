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

// the balconies keep the shared lambert material; only the windows get their own
// material below, because they light up at night. Like the building/tree
// materials it is a module singleton and is never disposed
export const facadeMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

// How many windows light up at night, and how often a whole building stays
// dark. Tuned so a street reads as a city at night: mostly dark glass with a
// scatter of warm windows, not a uniform glow.
export const LIT_WINDOW_FRACTION = 0.34;
export const DARK_BUILDING_FRACTION = 0.08;

// The warm interior light of a lit window, in linear space (see uGlow below).
// Kept a saturated amber so a lit window reads as a lamp, not a white blob.
const WINDOW_GLOW = 0xffb15a;

/*
 * Windows and doors as one merged geometry per tile, drawn with their own
 * ShaderMaterial: a vertex carries its glass `color` plus `aLight` (1 for the
 * seeded subset of lit windows, 0 otherwise) and `aFrame` (1 for a window, 0 for
 * the door). A `uNight` uniform blends between the glass of the day and the
 * amber lamps of the night, so the whole city can go dark without rebuilding any
 * geometry.
 *
 * The frame, the sill and the mullion are painted procedurally from the quad's
 * uv, so they cost no extra triangles: a windowed city has hundreds of thousands
 * of windows, and real frames would triple that. `aFrame` keeps them off the
 * door, whose uv square would otherwise look like a window.
 *
 * It does its own lighting rather than using a lambert material because it also
 * needs the night branch; the day branch is a plain lambert term (key light +
 * ambient, times RECIPROCAL_PI like three's BRDF_Lambert), fed the same sun the
 * scene lights use, so it still tracks dawn and dusk.
 */
export const windowMaterial = new THREE.ShaderMaterial({
  vertexColors: true,
  uniforms: {
    uNight: { value: 0 },
    uKeyDirection: { value: new THREE.Vector3(0, -0.35, 1).normalize() },
    uKeyColor: { value: new THREE.Color(0xfff2df) },
    uKeyIntensity: { value: 2.4 },
    uAmbientColor: { value: new THREE.Color(0xcfe0ff) },
    uAmbientIntensity: { value: 1.0 },
    uGlow: { value: new THREE.Color(WINDOW_GLOW) },
  },
  vertexShader: /* glsl */ `
    attribute float aLight;
    attribute float aFrame;
    varying vec3 vColor;
    varying float vLight;
    varying float vFrame;
    varying vec2 vUv;
    varying vec3 vNormal;
    void main() {
      vColor = color;
      vLight = aLight;
      vFrame = aFrame;
      vUv = uv;
      // the facade meshes carry no local transform, so the object-space normal
      // is already the model-space one the lights are expressed in
      vNormal = normal;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uNight;
    uniform vec3 uKeyDirection;
    uniform vec3 uKeyColor;
    uniform float uKeyIntensity;
    uniform vec3 uAmbientColor;
    uniform float uAmbientIntensity;
    uniform vec3 uGlow;
    varying vec3 vColor;
    varying float vLight;
    varying float vFrame;
    varying vec2 vUv;
    varying vec3 vNormal;

    const float INV_PI = 0.3183099;

    // The frame and sill are a fixed fraction of the quad, not a fixed number of
    // meters: that makes them thin on a small window and chunky on a wide one,
    // but it needs no per-window size attribute. Acceptable at facade zoom.
    const float FRAME_BAND = 0.075;
    const float SILL_BAND = 0.13;
    const float MULLION_HALF = 0.012;

    void main() {
      // day: the same lambert term the rest of the facade gets from the lights
      float ndl = max(dot(normalize(vNormal), uKeyDirection), 0.0);
      vec3 light = uAmbientColor * uAmbientIntensity + uKeyColor * uKeyIntensity * ndl;

      // OSM has no frame color, so derive one from the glass: lift it toward
      // white to get painted wood or uPVC. The sill converges to a warm stone
      // tone instead of just brightening, so it still reads on a white frame
      // (slightly darker, like a shadowed ledge) and on a dark one (brighter).
      vec3 frameColor = clamp(vColor * 1.35 + 0.18, 0.0, 1.0);
      vec3 sillColor = clamp(frameColor * 0.82 + 0.14, 0.0, 1.0);

      // uv runs 0..1 across the quad, v = 0 at the bottom (see pushQuad); the
      // border is the distance to the nearest edge in uv space
      float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
      float isSill = step(vUv.y, SILL_BAND);
      float trim = max(step(edge, FRAME_BAND), isSill);
      trim = max(trim, step(abs(vUv.x - 0.5), MULLION_HALF));
      // doors and balconies share the shader but never get a frame
      trim *= vFrame;
      vec3 trimColor = mix(frameColor, sillColor, isSill);

      vec3 day = mix(vColor, trimColor, trim) * light * INV_PI;
      // night: unlit glass goes near-black, a lit window glows warm amber
      vec3 darkGlass = vColor * 0.05;
      vec3 litWindow = vColor * 0.2 + uGlow;
      vec3 night = mix(darkGlass, litWindow, vLight);
      // the frame is painted, not lit from inside: a faint ambient keeps its
      // outline readable against a lit window without joining the glow
      night = mix(night, trimColor * 0.09, trim);

      gl_FragColor = vec4(mix(day, night, uNight), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
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

// the six vertex buffers of a geometry being built: position, normal, uv,
// color, the per-window night light flag and the "this quad is a window, draw a
// frame and sill" flag. The last two stay zero for doors and balconies.
type Buffers = [number[], number[], number[], number[], number[], number[]];

// the unit-square uv of the four corners in the order pushQuad lays them out:
// bottom-left, bottom-right, top-right, top-left. Indexed by the ORIGINAL
// corner, so the winding reorder in pushFace cannot scramble it.
const CORNER_UV: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

interface Edge {
  a: Point;
  dir: Point;
  normal: Point;
  length: number;
}

// append a quad. The winding is set so the face points along `facing`: three.js
// culls back faces, and OSM rings come in both windings, so getting this wrong
// makes quads invisible from the side that matters. `light` is the per-vertex
// night flag (a lit window is 1); `frame` asks the window shader to draw a frame
// and a sill inside the quad (1 for windows, 0 for doors and balconies).
function pushFace(
  buffers: Buffers,
  corners: Triple[],
  facing: Triple,
  rgb: THREE.Color,
  light = 0,
  frame = 0,
): void {
  const [position, normal, uv, color, lit, framed] = buffers;
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
    uv.push(CORNER_UV[i][0], CORNER_UV[i][1]);
    color.push(rgb.r, rgb.g, rgb.b);
    lit.push(light);
    framed.push(frame);
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
  light = 0,
  frame = 0,
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
    light,
    frame,
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
  const windows: Buffers = [[], [], [], [], [], []];
  const balconies: Buffers = [[], [], [], [], [], []];
  const rgb = new THREE.Color();

  for (const info of infos) {
    // a curtain wall is glass end to end: windows, balconies and a door would
    // all be painted on the panes, so it gets none of this detail
    if (info.glass) continue;
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
    // a third stream decides which windows are lit, so drawing the night lights
    // does not disturb the window layout
    const lightRng = makeRng(hashSeed(`${seed}:light`));
    const buildingDark = lightRng() < DARK_BUILDING_FRACTION;
    const base = info.base ?? 0;
    const usableHeight = Math.max(0.1, info.height - base);
    const bands = floorBands(usableHeight, rng).map((band) => ({
      ...band,
      start: band.start + base,
    }));
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
          const lit = !buildingDark && lightRng() < LIT_WINDOW_FRACTION ? 1 : 0;
          pushQuad(
            windows,
            along(edge, column.start),
            along(edge, column.start + column.width),
            band.start,
            band.start + band.width,
            edge.normal,
            windowColor,
            lit,
            1,
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

    // one door, on the longest ground-floor facade. A door is never lit.
    const door =
      base < 0.5 && longest && usableHeight > DOOR_HEIGHT + 0.1
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

// positions/normals/uvs/colors/light/frame -> a BufferGeometry, or null when
// empty
function geometryFrom(buffers: number[][]): THREE.BufferGeometry | null {
  const [position, normal, uv, color, light, frame] = buffers;
  if (position.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(position, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(color, 3));
  geometry.setAttribute("aLight", new THREE.Float32BufferAttribute(light, 1));
  geometry.setAttribute("aFrame", new THREE.Float32BufferAttribute(frame, 1));
  return geometry;
}
