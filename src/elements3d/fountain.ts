import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";

import { toModelCoords } from "../geojson_data";
import { applyVertexColor } from "./vertex_color";
import { hashSeed } from "./random";

/*
 * Fountains: a low stone basin with a water disc and, for the larger ones, a
 * central pedestal, bowl and jet.
 *
 * tilegen emits one point per fountain with an equivalent diameter (a fountain
 * mapped as an area collapses to its centroid, a node keeps a small default).
 * The stone is one Lambert mesh per tile (kind `fountain`); the water is a
 * separate mesh (kind `fountain_water`) with a small shader that ripples the
 * basin and runs moving bands up the jet. Splitting the two is what lets the
 * water animate without giving up the shared stone material.
 */

const STONE = new THREE.Color("#b7b2a5");
const STONE_DARK = new THREE.Color("#8f8a7c");
const WATER = new THREE.Color("#3f7fa5");
const JET = new THREE.Color("#cfeaff");

export const FOUNTAIN_MIN_SIZE = 1.5;
export const FOUNTAIN_MAX_SIZE = 12;

export const fountainMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

// The basin and jet read as one surface but at very different scales: a slow
// radial ripple on the flat discs, faster travelling bands on the vertical jet.
// The shader is unlit and cheap; no transparency, so no sorting between
// thousands of fountains.
export const fountainWaterMaterial = new THREE.ShaderMaterial({
  vertexColors: true,
  uniforms: {
    uTime: { value: 0 },
    uNight: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vColor;
    varying vec3 vNormal;
    varying vec3 vPosition;
    void main() {
      vColor = color;
      vNormal = normal;
      vPosition = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform float uNight;
    varying vec3 vColor;
    varying vec3 vNormal;
    varying vec3 vPosition;
    void main() {
      float onSurface = smoothstep(0.55, 0.9, abs(normalize(vNormal).z));
      float ripple =
        0.5 + 0.5 * sin(vPosition.x * 1.6 + vPosition.y * 1.2 + uTime * 1.7);
      float rings =
        0.5 + 0.5 * sin(length(vPosition.xy) * 3.5 - uTime * 2.4);
      float jet =
        0.5 + 0.5 * sin(vPosition.z * 9.0 - uTime * 4.0 + vPosition.x * 3.0);
      vec3 color = vColor;
      color +=
        (0.12 * ripple * onSurface +
          0.10 * rings * onSurface +
          0.18 * jet * (1.0 - onSurface)) *
        vColor;
      color = mix(color, color * 0.35, uNight);
      gl_FragColor = vec4(color, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
});

export interface FountainGeometry {
  stone: THREE.BufferGeometry[];
  water: THREE.BufferGeometry[];
}

function coloured(
  geometry: THREE.BufferGeometry,
  color: THREE.Color,
): THREE.BufferGeometry {
  applyVertexColor(geometry, color);
  return geometry;
}

// a cylinder standing on z, centered at its own height
function column(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  baseZ: number,
  segments: number,
  color: THREE.Color,
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(
    radiusTop,
    radiusBottom,
    height,
    segments,
  );
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, baseZ + height / 2);
  return coloured(geometry, color);
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  const geometry = BufferGeometryUtils.mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return geometry;
}

/** The stone and water geometries for one fountain point. */
export function fountain(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): FountainGeometry {
  const geometry = f.geometry;
  if (geometry.type !== "Point") {
    throw Error(`Cannot have fountain of type ${geometry.type}`);
  }
  const props = f.properties as { size?: unknown } | null;
  const requested = Number(props?.size);
  const size = Number.isFinite(requested)
    ? Math.min(FOUNTAIN_MAX_SIZE, Math.max(FOUNTAIN_MIN_SIZE, requested))
    : 2.4;
  const radius = size / 2;

  const stoneParts: THREE.BufferGeometry[] = [];
  const waterParts: THREE.BufferGeometry[] = [];

  stoneParts.push(column(radius, radius * 1.04, 0.35, 0, 12, STONE_DARK));
  // a raised coping ring, so the basin edge reads at street level
  const rim = new THREE.TorusGeometry(radius * 0.98, 0.09, 4, 16);
  rim.translate(0, 0, 0.37);
  stoneParts.push(coloured(rim, STONE));
  // the water sits just above the stone top, inside the coping
  const surface = new THREE.CircleGeometry(radius * 0.86, 12);
  surface.translate(0, 0, 0.36);
  waterParts.push(coloured(surface, WATER));

  if (radius > 1.1) {
    stoneParts.push(column(0.18, 0.24, 0.9, 0.36, 8, STONE));
    stoneParts.push(column(0.5, 0.4, 0.14, 1.26, 10, STONE_DARK));
    const bowl = new THREE.CircleGeometry(0.42, 10);
    bowl.translate(0, 0, 1.34);
    waterParts.push(coloured(bowl, WATER));
    waterParts.push(column(0.035, 0.06, 0.5, 1.34, 6, JET));
  } else {
    waterParts.push(column(0.03, 0.05, 0.35, 0.36, 6, JET));
  }

  const stone = merged(stoneParts);
  const water = merged(waterParts);
  const [x, y] = toModelCoords(
    [geometry.coordinates[0], geometry.coordinates[1]],
    originMeters,
    scaleFactor,
  );
  const angle = (hashSeed(`${f.id}`) % 4) * (Math.PI / 2);
  for (const part of [stone, water]) {
    part?.rotateZ(angle);
    part?.translate(x, y, 0);
  }
  return {
    stone: stone ? [stone] : [],
    water: water ? [water] : [],
  };
}
