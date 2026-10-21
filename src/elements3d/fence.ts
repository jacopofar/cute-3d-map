import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../geojson_data";
import { applyVertexColor } from "./vertex_color";

/*
 * Fences: the OSM `barrier=fence` (and guard rail / railing) lines, drawn as a
 * thin vertical band along the line and carved into posts and rails by the
 * shader. The band is a plane, so nothing is simulated and one merged mesh per
 * tile draws the whole layer.
 *
 * The alternative (real geometry for every post and rail) would be many times
 * the triangles for something that is a two-meter-tall detail read from a few
 * meters away, so the holes are discarded in the fragment shader instead.
 * tilegen clips a fence to the tile, like water, so a long fence is split here.
 */

// the band height in meters: about eye level, tall enough to read over the
// pavement, short enough not to hide what is behind it
export const FENCE_HEIGHT = 1.15;
// distance between posts, and the width of a post, in meters
export const FENCE_PITCH = 2.0;
export const FENCE_POST_WIDTH = 0.12;
// the rails at 0 (ground) to 1 (top), as (center, half thickness). Three rails
// and a post every couple of meters read as a fence; two look like a railing,
// four look like a ladder.
export const FENCE_RAILS: [number, number][] = [
  [0.3, 0.055],
  [0.62, 0.055],
  [0.95, 0.045],
];

// grey fences and galvanized guard rails; the OSM sub-kind only changes the
// coolness a little, not the material story
export const FENCE_COLORS: Record<string, string> = {
  fence: "#8b9296",
  guard_rail: "#9aa2a8",
  railing: "#9aa2a8",
};
export const DEFAULT_FENCE_COLOR = "#8b9296";

export function fenceColor(barrier: string): THREE.Color {
  return new THREE.Color(FENCE_COLORS[barrier] ?? DEFAULT_FENCE_COLOR);
}

function barrierOf(f: Geojson.Feature): string {
  const props = f.properties as { barrier?: unknown } | null;
  return props && typeof props.barrier === "string" ? props.barrier : "fence";
}

// the band profile of a polyline, in model meters: a quad per segment from
// ground to `height`, with `u` the distance along the line and `z` the height
// fraction. Pure maths, so the shader's post/rail pattern is unit-tested.
export interface FenceBand {
  positions: number[];
  u: number[];
  z: number[];
}

export function fenceBand(
  points: [number, number][],
  height: number = FENCE_HEIGHT,
): FenceBand {
  const positions: number[] = [];
  const u: number[] = [];
  const z: number[] = [];
  const push = (p: [number, number], along: number, up: number) => {
    positions.push(p[0], p[1], up * height);
    u.push(along);
    z.push(up);
  };
  let along = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // a duplicate node would leave a degenerate quad; the distance still has to
    // advance so the posts stay on pitch
    if (length < 1e-6) continue;
    // two triangles: a base, a top, b top / a base, b top, b base
    push(a, along, 0);
    push(a, along, 1);
    push(b, along + length, 1);
    push(a, along, 0);
    push(b, along + length, 1);
    push(b, along + length, 0);
    along += length;
  }
  return { positions, u, z };
}

// the polylines of a feature: a barrier drawn as a closed area (a fenced
// enclosure) contributes its rings, though tilegen already emits outlines
function polylines(f: Geojson.Feature): Geojson.Position[][] {
  const g = f.geometry;
  if (g.type === "LineString") return [g.coordinates];
  if (g.type === "MultiLineString") return g.coordinates;
  if (g.type === "Polygon") return g.coordinates;
  if (g.type === "MultiPolygon") return g.coordinates.flat();
  throw Error(`Cannot build a fence of type ${g.type}`);
}

/**
 * The fence geometries for one feature: one band per polyline part. Every
 * geometry carries position, color, aU (distance along the fence) and aZ
 * (height 0..1), so a tile merges them into a single mesh the shader carves.
 */
export function fence(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const color = fenceColor(barrierOf(f));
  const geometries: THREE.BufferGeometry[] = [];
  for (const line of polylines(f)) {
    const points = line.map((c) =>
      toModelCoords([c[0], c[1]], originMeters, scaleFactor),
    );
    if (points.length < 2) continue;
    const band = fenceBand(points);
    if (band.positions.length === 0) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(band.positions, 3),
    );
    geometry.setAttribute("aU", new THREE.Float32BufferAttribute(band.u, 1));
    geometry.setAttribute("aZ", new THREE.Float32BufferAttribute(band.z, 1));
    applyVertexColor(geometry, color);
    geometries.push(geometry);
  }
  return geometries;
}

/**
 * One shared fence material. A ShaderMaterial (not a lit one): the posts and
 * rails are carved by discarding the gap fragments, which needs no normals or
 * lights and keeps a very long, very thin layer cheap. `DoubleSide` because the
 * band is a plane and a fence is seen from either side.
 */
export const fenceMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uPitch: { value: FENCE_PITCH },
    uPostWidth: { value: FENCE_POST_WIDTH },
    // rails as (center, half thickness) triples, flattened for the GPU
    uRails: {
      value: FENCE_RAILS.flatMap(([center, half]) => [center, half]),
    },
  },
  vertexShader: /* glsl */ `
    attribute vec3 color;
    attribute float aU;
    attribute float aZ;
    varying vec3 vColor;
    varying float vU;
    varying float vZ;
    void main() {
      vColor = color;
      vU = aU;
      vZ = aZ;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uPitch;
    uniform float uPostWidth;
    uniform float uRails[6];
    varying vec3 vColor;
    varying float vU;
    varying float vZ;

    // 1 inside a rail of half thickness halfWidth around center
    float rail(float z, float center, float halfWidth) {
      return 1.0 - step(halfWidth, abs(z - center));
    }

    void main() {
      // the post nearest this fragment: u wraps every pitch
      float local = vU - uPitch * floor(vU / uPitch);
      float post = step(local, uPostWidth);
      float rails = rail(vZ, uRails[0], uRails[1]);
      rails = max(rails, rail(vZ, uRails[2], uRails[3]));
      rails = max(rails, rail(vZ, uRails[4], uRails[5]));
      // the gaps are the fence: without this it is a solid plank wall
      if (post + rails < 0.5) discard;
      // unlit: ground the band with a slight vertical gradient, and lift the
      // posts a touch so they read against the rails
      vec3 color = vColor * (0.78 + 0.22 * vZ) * mix(0.9, 1.0, post);
      gl_FragColor = vec4(color, 1.0);
    }
  `,
  side: THREE.DoubleSide,
});
