import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { flatPolygon } from "./flat_polygon";
import { applyVertexColor } from "./vertex_color";

/*
 * Animated water: lakes, ponds and reservoirs as flat polygons, and rivers,
 * canals and streams as flat ribbons. Both are drawn at ground level (z = 0) by
 * a single shader that drifts a stylized ripple field across the surface, so
 * the water reads as moving without a real wave simulation.
 *
 * tilegen clips water to each tile (a lake spans many tiles), so every feature
 * here is already the piece that belongs to the tile; the geometry is built in
 * the same model space as the buildings and merged per tile into one mesh.
 */

// full ribbon width in meters per waterway class: a river is a wide band, a
// ditch a thin one. Areas ignore this (their width is the polygon itself).
export const WATERWAY_WIDTH: Record<string, number> = {
  river: 14,
  canal: 9,
  stream: 3.5,
  drain: 2.5,
  ditch: 2,
};
export const DEFAULT_WATERWAY_WIDTH = 4;

// base tint per water kind; the shader animates ripples over it. Deliberately
// muted so it sits next to the toon buildings instead of glowing.
export const WATER_COLORS: Record<string, string> = {
  lake: "#2f6f9e",
  reservoir: "#2f6f9e",
  basin: "#3a7ca5",
  pond: "#37718e",
  wetland: "#4c7a5a",
  river: "#3a86b8",
  canal: "#3d7fa6",
  stream: "#4a90b8",
  drain: "#4a90b8",
  ditch: "#4a90b8",
};
export const DEFAULT_WATER_COLOR = "#2f6f9e";

// a water body below level 0 is underwater: draw it almost transparent so it
// reads as submerged rather than as a surface
export const UNDERWATER_OPACITY = 0.1;

const HALF = 0.5;

export function waterKindOf(f: Geojson.Feature): string {
  const props = f.properties as { water?: unknown } | null;
  return props && typeof props.water === "string" ? props.water : "";
}

export function waterColor(kind: string): THREE.Color {
  return new THREE.Color(WATER_COLORS[kind] ?? DEFAULT_WATER_COLOR);
}

export function waterwayWidth(kind: string): number {
  return WATERWAY_WIDTH[kind] ?? DEFAULT_WATERWAY_WIDTH;
}

// how opaque a water feature is: a negative OSM `layer` means below ground
// (underwater), drawn faint; everything else is a solid surface
export function waterFade(f: Geojson.Feature): number {
  const props = f.properties as { layer?: unknown } | null;
  const layer = props ? Number(props.layer) : NaN;
  return Number.isFinite(layer) && layer < 0 ? UNDERWATER_OPACITY : 1;
}

// bake the fade into a per-vertex attribute, so the shader can vary the alpha
// within one merged mesh
function applyFade(geometry: THREE.BufferGeometry, fade: number): void {
  const count = geometry.getAttribute("position").count;
  const values = new Float32Array(count).fill(fade);
  geometry.setAttribute("aFade", new THREE.BufferAttribute(values, 1));
}

// 1 at a waterway bank, 0 in its middle (and 0 everywhere on an area). Only
// the areas use this filler: a ribbon bakes its own per-vertex values. Every
// water geometry has to carry the attribute, or merging the tile's water
// geometries returns null and the whole layer disappears for that tile. See
// the comment in areaGeometry.
function applyFoam(geometry: THREE.BufferGeometry, foam: number): void {
  const count = geometry.getAttribute("position").count;
  geometry.setAttribute(
    "aFoam",
    new THREE.BufferAttribute(new Float32Array(count).fill(foam), 1),
  );
}

// a polyline turned into a flat band: each point is pushed half a width to
// either side of the centreline. The offset uses the average of the two
// adjacent segments, so a bend does not pinch to nothing.
//
// The band carries three rows (bank, centreline, bank) instead of the bare two
// the surface needs: the extra row is what lets `aFoam` fade from the bank
// inward. Widths are the same, at the cost of two more triangles per segment.
function ribbonGeometry(
  coords: Geojson.Position[],
  halfWidth: number,
  originMeters: [number, number],
  scaleFactor: number,
): THREE.BufferGeometry | null {
  const points = coords.map((c) =>
    toModelCoords([c[0], c[1]], originMeters, scaleFactor),
  );
  if (points.length < 2) return null;
  const offsets: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) {
      dx = 1;
      dy = 0;
    } else {
      dx /= len;
      dy /= len;
    }
    offsets.push([-dy * halfWidth, dx * halfWidth]);
  }
  const positions: number[] = [];
  const foam: number[] = [];
  const row = (p: [number, number], o: [number, number], side: number) => [
    p[0] + o[0] * side,
    p[1] + o[1] * side,
  ];
  // `side` is 1 for the left bank, 0 for the centreline row, -1 for the right;
  // foam is 1 on a bank and 0 down the middle
  const push = (p: [number, number], o: [number, number], side: number) => {
    const [x, y] = row(p, o, side);
    positions.push(x, y, 0);
    foam.push(Math.abs(side));
  };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const oa = offsets[i];
    const ob = offsets[i + 1];
    // same winding as the old two-row ribbon, split down the middle
    push(a, oa, 1);
    push(a, oa, 0);
    push(b, ob, 1);
    push(a, oa, 0);
    push(b, ob, 0);
    push(b, ob, 1);
    push(a, oa, 0);
    push(a, oa, -1);
    push(b, ob, 0);
    push(a, oa, -1);
    push(b, ob, -1);
    push(b, ob, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("aFoam", new THREE.Float32BufferAttribute(foam, 1));
  return geometry;
}

/**
 * The water geometries for one feature: one per polygon part (areas) or per
 * line part (ribbons), all flat at z = 0 with a baked base color. Empty when
 * the feature has no usable geometry.
 */
export function water(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const kind = waterKindOf(f);
  const color = waterColor(kind);
  const fade = waterFade(f);
  const geometries: THREE.BufferGeometry[] = [];

  const addArea = (rings: Geojson.Position[][]) => {
    const geometry = flatPolygon(rings, originMeters, scaleFactor);
    if (geometry) {
      applyVertexColor(geometry, color);
      applyFade(geometry, fade);
      // a lake has no bank inside the tile: the foam attribute is present but
      // silent, so the merge sees the same set as a ribbon
      applyFoam(geometry, 0);
      geometries.push(geometry);
    }
  };
  const addLine = (coords: Geojson.Position[]) => {
    const geometry = ribbonGeometry(
      coords,
      waterwayWidth(kind) * HALF,
      originMeters,
      scaleFactor,
    );
    if (geometry) {
      applyVertexColor(geometry, color);
      applyFade(geometry, fade);
      geometries.push(geometry);
    }
  };

  const g = f.geometry;
  if (g.type === "Polygon") addArea(g.coordinates);
  else if (g.type === "MultiPolygon") g.coordinates.forEach(addArea);
  else if (g.type === "LineString") addLine(g.coordinates);
  else if (g.type === "MultiLineString") g.coordinates.forEach(addLine);
  else throw Error(`Cannot have water of type ${g.type}`);

  return geometries;
}

// The highlight the shader adds on top of the base color; bright and slightly
// blue so the moving glints read as reflected sky.
const HIGHLIGHT = new THREE.Color("#cfeaff");

/**
 * The physical camera behind a MapLibre projection: MapLibre bakes the whole
 * view into the projection matrix, so the shader's built-in `cameraPosition`
 * (the scene origin) is not where the eye is. The camera is the point the
 * matrix sends nowhere, i.e. the null vector of the three top rows: solve
 * P * [C, 1] = 0. The glitter swath needs the eye's ground point to know which
 * side of the water faces the sun. Pure and unit-tested; `out` is reused so
 * the render loop allocates nothing.
 */
export function cameraCenter(
  projection: THREE.Matrix4,
  out: THREE.Vector3,
): THREE.Vector3 {
  const e = projection.elements;
  // The eye is where the image coordinates vanish: the point that makes the
  // x row, the y row and the w row of the matrix all zero. The clip-z row is
  // deliberately left out (it is depth, not an image coordinate).
  const a = new THREE.Matrix3().set(
    e[0],
    e[4],
    e[8],
    e[1],
    e[5],
    e[9],
    e[3],
    e[7],
    e[11],
  );
  return out
    .set(e[12], e[13], e[15])
    .applyMatrix3(a.invert())
    .multiplyScalar(-1);
}

/**
 * One shared water material. A ShaderMaterial (not a lit one): the ripples are
 * procedural, so there are no lights or normals to feed. `uTime` is advanced by
 * the render loop, and `uSunDirection` / `uSunColor` come from the same key
 * light the windows use, so the glitter path follows the real sun. The ripples
 * are anchored to model space, so a rebuild (or an origin reset) shifts their
 * phase once; that is invisible on a moving surface.
 */
export const waterMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uHighlight: { value: HIGHLIGHT },
    // 0 by day, 1 at night; dims the (unlit) water so a lake does not glow
    // bright blue next to the dark buildings
    uNight: { value: 0 },
    // the key light, in model space; seeded so a test that never renders still
    // gets a sane shader
    uSunDirection: { value: new THREE.Vector3(0, -0.35, 1).normalize() },
    uSunColor: { value: new THREE.Color(0xfff2df) },
    uSunIntensity: { value: 2.4 },
    // the eye, in model space; refreshed from the projection each frame
    uCameraPosition: { value: new THREE.Vector3(0, 0, 1000) },
  },
  vertexShader: /* glsl */ `
    attribute vec3 color;
    attribute float aFade;
    attribute float aFoam;
    varying vec3 vColor;
    varying float vFade;
    varying float vFoam;
    varying vec2 vPos;
    void main() {
      vColor = color;
      vFade = aFade;
      vFoam = aFoam;
      vPos = position.xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform vec3 uHighlight;
    uniform float uNight;
    uniform vec3 uSunDirection;
    uniform vec3 uSunColor;
    uniform float uSunIntensity;
    uniform vec3 uCameraPosition;
    varying vec3 vColor;
    varying float vFade;
    varying float vFoam;
    varying vec2 vPos;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    void main() {
      float t = uTime;
      // two slow crossing swells plus a finer grain, all drifting, give an
      // irregular ripple field rather than a regular grid of waves
      float swell =
        sin(vPos.x * 0.045 + t * 0.7) *
        sin(vPos.y * 0.060 - t * 0.5) * 0.5 + 0.5;
      float grain = noise(vPos * 0.08 + vec2(t * 0.25, -t * 0.18));
      // two extra octaves keep the surface crisp when the camera is close;
      // fwidth fades them before they turn into shimmer at city scale
      float fine = noise(vPos * 0.38 + vec2(t * 0.55, -t * 0.42));
      float micro = noise(vPos * 1.25 - vec2(t * 0.9, -t * 0.7));
      float ripple = clamp(
        swell * 0.48 + grain * 0.28 + fine * 0.17 + micro * 0.07,
        0.0,
        1.0
      );
      float detailFade = 1.0 - smoothstep(0.25, 1.4, max(fwidth(vPos.x), fwidth(vPos.y)));

      // narrow bright bands that travel across the surface
      float bands =
        0.5 + 0.5 * sin((ripple * 6.0 + grain * 3.0 + fine * 1.2) * 6.2831853 - t * 1.6);
      float glint = pow(bands, 28.0);
      float fineBands =
        0.5 + 0.5 * sin(vPos.x * 0.62 + vPos.y * 0.47 - t * 2.3 + micro * 9.0);
      float crisp = pow(fineBands, 30.0) * detailFade;

      // Sun glitter: the bands run along the sun's azimuth, so the sparkle
      // reads as a path toward the sun rather than random noise. A true
      // mirror reflection would sit out at the horizon, where a map view
      // cannot see it, so this is deliberately stylised.
      vec2 sunFlat = normalize(uSunDirection.xy + vec2(1e-5));
      vec2 away = normalize(vPos - uCameraPosition.xy + vec2(1e-5));
      float swath = pow(max(dot(away, sunFlat), 0.0), 5.0);
      float alongSun = dot(vPos, sunFlat);
      float sunBands =
        0.5 + 0.5 * sin(alongSun * 0.18 - t * 1.5 + ripple * 6.0 + fine * 2.0);
      float sunGlint = pow(sunBands, 24.0);
      float sunFine =
        pow(
          0.5 + 0.5 * sin(alongSun * 0.42 - t * 2.5 + micro * 10.0),
          30.0
        ) * detailFade;

      // a low sun paints a long, warm path: full strength at dusk, a faint
      // sheen at noon. uNight then dims whatever is left.
      float lowSun = 1.0 - smoothstep(0.15, 0.65, uSunDirection.z);
      float sunPower = uSunIntensity * 0.4 * mix(0.1, 1.0, lowSun);
      vec3 glitter =
        uSunColor *
        (0.25 + sunGlint * 1.05 + sunFine * 0.45 + glint * 0.8) *
        (0.5 + swath) * sunPower;

      vec3 color = mix(vColor * 0.82, vColor, ripple);
      // a faint sky sheen from the travelling bands, so still water reads as a
      // surface even when the sun is not in view
      color += uHighlight * (glint * 0.22 + crisp * 0.16);
      // bank foam: the ribbon's outer rows, broken up by drifting noise so it
      // reads as lapping water and not a painted kerb. fwidth fades it out
      // once the ribbon is only a couple of pixels wide, where it would just
      // shimmer. Areas carry aFoam = 0, so lakes get none: tilegen clips them,
      // and a ring foam would draw a seam across every tile boundary.
      float bank = smoothstep(0.55, 1.0, vFoam);
      float lap = noise(vPos * 0.5 + vec2(t * 0.25, -t * 0.12));
      float foam = bank * smoothstep(0.4, 0.8, lap);
      foam *= 1.0 - smoothstep(0.3, 0.7, fwidth(vFoam));
      color = mix(color, uHighlight, foam * 0.6);
      color += glitter;
      // at night keep the water dark, with just a hint of reflected moonlight
      color = mix(color, color * 0.28 + uHighlight * glint * 0.15, uNight);
      gl_FragColor = vec4(color, vFade);
    }
  `,
  // aFade varies within a tile (surface vs underwater), so the material blends;
  // it does not write depth, so the faint underwater water does not hide the
  // ground or the water behind it
  transparent: true,
  depthWrite: false,
});
