import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { applyVertexColor } from "./vertex_color";

/*
 * Green areas — parks, woods, lawns and pitches — as flat, shader-shaded
 * polygons. Two styles share one material: a per-vertex `aStyle` attribute
 * selects mown lawn stripes (0) or dense vegetation (1). tilegen clips each area
 * to the tile it lands in (a park spans many tiles), so the geometry here is the
 * piece that belongs to this tile, in the same model space as the buildings.
 */

// the green surface sits just below the water planes (z = 0, so a riverbank
// still reads as water) and above the ground plane (z = -0.05), so it z-fights
// with neither. 2 cm is enough to beat depth precision at these tile sizes.
export const GREEN_Z = -0.02;
// dense vegetation sits a hair lower than the mown style, so a wood clipped
// inside a park (both drawn on the tile) does not z-fight with the lawn
export const GREEN_DENSE_Z = -0.04;

// shader style per sub-kind: "grass" is a mown lawn/pitch/garden, "dense" a
// park/wood/scrub. Unknown kinds fall back to the lawn style.
export const GREEN_STYLES: Record<string, number> = { grass: 0, dense: 1 };
export const DEFAULT_GREEN_STYLE = 0;

// base tint per sub-kind, baked into the vertex colors and modulated by the
// shader. grass is fresh and yellow-green, dense is deeper and darker; the two
// areas still differ because the shader noise is anchored in model space.
export const GREEN_COLORS: Record<string, string> = {
  grass: "#6a9a3c",
  dense: "#48783a",
};
export const DEFAULT_GREEN_COLOR = "#5c8a44";

export function greenKindOf(f: Geojson.Feature): string {
  const props = f.properties as { green?: unknown } | null;
  return props && typeof props.green === "string" ? props.green : "";
}

export function greenStyle(kind: string): number {
  return GREEN_STYLES[kind] ?? DEFAULT_GREEN_STYLE;
}

export function greenColor(kind: string): THREE.Color {
  return new THREE.Color(GREEN_COLORS[kind] ?? DEFAULT_GREEN_COLOR);
}

// a flat, triangulated polygon (holes included) lying in the z = GREEN_Z plane
function areaGeometry(
  rings: Geojson.Position[][],
  originMeters: [number, number],
  scaleFactor: number,
  z: number,
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
  // the shader shades the surface, so the flat normal/uv are dropped: every
  // green geometry keeps the same position+color+aStyle set, or the per-tile
  // merge would return null and the whole kind would be dropped
  const geometry = shape.index ? shape.toNonIndexed() : shape;
  geometry.deleteAttribute("normal");
  geometry.deleteAttribute("uv");
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i++) position.setZ(i, z);
  return position.count >= 3 ? geometry : null;
}

// the shader style as a per-vertex attribute, so one mesh can hold both styles
function applyStyle(geometry: THREE.BufferGeometry, style: number): void {
  const count = geometry.getAttribute("position").count;
  const values = new Float32Array(count).fill(style);
  geometry.setAttribute("aStyle", new THREE.BufferAttribute(values, 1));
}

/**
 * The green geometries for one feature: one per polygon part, all flat at
 * z = GREEN_Z with a baked base tint and a shader-style attribute. Empty when
 * the feature has no usable geometry.
 */
export function green(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const kind = greenKindOf(f);
  const color = greenColor(kind);
  const style = greenStyle(kind);
  const z = style === 1 ? GREEN_DENSE_Z : GREEN_Z;
  const geometries: THREE.BufferGeometry[] = [];

  const addArea = (rings: Geojson.Position[][]) => {
    const geometry = areaGeometry(rings, originMeters, scaleFactor, z);
    if (geometry) {
      applyVertexColor(geometry, color);
      applyStyle(geometry, style);
      geometries.push(geometry);
    }
  };

  const g = f.geometry;
  if (g.type === "Polygon") addArea(g.coordinates);
  else if (g.type === "MultiPolygon") g.coordinates.forEach(addArea);
  else throw Error(`Cannot have green of type ${g.type}`);

  return geometries;
}

/**
 * One shared green material. A ShaderMaterial (not a lit one): the surface is
 * procedural, so there are no lights or normals to feed. `uTime` gives the dense
 * style a slow drift; the striped style ignores it. Both styles work in model
 * space, so an origin reset shifts the pattern's phase once — invisible on noise.
 * The noise is deliberately cheap (two value-noise samples, reused by both
 * styles) because a city tile is many thousands of small green polygons.
 */
export const greenMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uNight: { value: 0 },
  },
  vertexShader: /* glsl */ `
    attribute vec3 color;
    attribute float aStyle;
    varying vec3 vColor;
    varying float vStyle;
    varying vec2 vPos;
    void main() {
      vColor = color;
      vStyle = aStyle;
      vPos = position.xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform float uNight;
    varying vec3 vColor;
    varying float vStyle;
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
      // a few cheap value-noise samples, shared by the two styles; three
      // octaves are enough to break up a park without costing a real texture
      float coarse = noise(vPos * 0.05 + vec2(t * 0.04, -t * 0.03));
      float mid = noise(vPos * 0.11 - vec2(0.0, t * 0.05));
      float fine = noise(vPos * 0.23 + vec2(t * 0.06, 0.0));

      // style 0: mown lawn, alternating bands along a fixed world direction so
      // neighbouring lawns stripe the same way instead of every one its own.
      // fwidth fades the bands out once one is under a pixel wide, or a
      // zoomed-out city view turns them into moire
      float phase = dot(vPos, vec2(0.82, -0.57)) * 0.9;
      float stripe = smoothstep(-0.4, 0.4, sin(phase));
      float contrast = 0.17 * (1.0 - smoothstep(0.5, 1.5, fwidth(phase)));
      vec3 lawn = vColor * (1.0 + contrast * (stripe * 2.0 - 1.0));
      lawn *= 0.88 + 0.24 * fine;

      // style 1: dense vegetation, a darker mottle with a slow drift
      float mottle = coarse * 0.55 + mid * 0.30 + fine * 0.15;
      vec3 dense = mix(vColor * 0.45, vColor * 1.35, mottle);

      vec3 color = mix(lawn, dense, vStyle);
      // the surface is unlit, so without this a park glows green in the dark
      color *= mix(1.0, 0.16, uNight);
      gl_FragColor = vec4(color, 1.0);
    }
  `,
});
