import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../geojson_data";
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

// how opaque a water feature is: a negative OSM level means below ground
// (underwater), drawn faint; everything else is a solid surface
export function waterFade(f: Geojson.Feature): number {
  const props = f.properties as { level?: unknown } | null;
  const level = props ? Number(props.level) : NaN;
  return Number.isFinite(level) && level < 0 ? UNDERWATER_OPACITY : 1;
}

// bake the fade into a per-vertex attribute, so the shader can vary the alpha
// within one merged mesh
function applyFade(geometry: THREE.BufferGeometry, fade: number): void {
  const count = geometry.getAttribute("position").count;
  const values = new Float32Array(count).fill(fade);
  geometry.setAttribute("aFade", new THREE.BufferAttribute(values, 1));
}

// a flat, triangulated polygon (holes included) lying in the z = 0 plane
function areaGeometry(
  rings: Geojson.Position[][],
  originMeters: [number, number],
  scaleFactor: number,
): THREE.BufferGeometry | null {
  const toVec = (c: Geojson.Position) =>
    new THREE.Vector2(
      ...toModelCoords([c[0], c[1]], originMeters, scaleFactor),
    );
  const outline = new THREE.Shape(rings[0].map(toVec));
  for (let h = 1; h < rings.length; h++) {
    outline.holes.push(new THREE.Path(rings[h].map(toVec)));
  }
  const shape = new THREE.ShapeGeometry(outline);
  // water is shaded by the shader, so the flat normal/uv the shape carries are
  // dropped: every water geometry keeps the same position+color attributes so
  // the per-tile merge never sees a mismatched set
  const geometry = shape.index ? shape.toNonIndexed() : shape;
  geometry.deleteAttribute("normal");
  geometry.deleteAttribute("uv");
  return geometry.getAttribute("position").count >= 3 ? geometry : null;
}

// a polyline turned into a flat band: each point is pushed half a width to
// either side of the centreline. The offset uses the average of the two
// adjacent segments, so a bend does not pinch to nothing.
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
  const push = (p: [number, number], o: [number, number], side: number) =>
    positions.push(p[0] + o[0] * side, p[1] + o[1] * side, 0);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const oa = offsets[i];
    const ob = offsets[i + 1];
    push(a, oa, 1);
    push(a, oa, -1);
    push(b, ob, 1);
    push(a, oa, -1);
    push(b, ob, -1);
    push(b, ob, 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
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
    const geometry = areaGeometry(rings, originMeters, scaleFactor);
    if (geometry) {
      applyVertexColor(geometry, color);
      applyFade(geometry, fade);
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
 * One shared water material. A ShaderMaterial (not a lit one): the ripples are
 * procedural, so there are no lights or normals to feed. `uTime` is advanced by
 * the render loop. The ripples are anchored to model space, so a rebuild (or an
 * origin reset) shifts their phase once; that is invisible on a moving surface.
 */
export const waterMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uHighlight: { value: HIGHLIGHT },
  },
  vertexShader: /* glsl */ `
    attribute vec3 color;
    attribute float aFade;
    varying vec3 vColor;
    varying float vFade;
    varying vec2 vPos;
    void main() {
      vColor = color;
      vFade = aFade;
      vPos = position.xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform vec3 uHighlight;
    varying vec3 vColor;
    varying float vFade;
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
      float ripple = clamp(swell * 0.65 + grain * 0.35, 0.0, 1.0);

      // narrow bright bands that travel across the surface
      float bands =
        0.5 + 0.5 * sin((ripple * 6.0 + grain * 3.0) * 6.2831853 - t * 1.6);
      float glint = pow(bands, 12.0);

      vec3 color = mix(vColor * 0.82, vColor, ripple);
      color += uHighlight * glint * 0.5;
      gl_FragColor = vec4(color, vFade);
    }
  `,
  // aFade varies within a tile (surface vs underwater), so the material blends;
  // it does not write depth, so the faint underwater water does not hide the
  // ground or the water behind it
  transparent: true,
  depthWrite: false,
});
