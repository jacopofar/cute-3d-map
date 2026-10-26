import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";

import { hashSeed } from "./random";
import { applyVertexColor } from "./vertex_color";

/*
 * The primitives the point props are made of: bollards, monuments, terrace
 * chairs, playground equipment, fountains, transit totems. Each of those
 * modules had its own `coloured`, `box` and `cylinder`, four copies of the same
 * twelve lines differing only in argument order — and one of them (the
 * playground's rider post) silently lost its position that way. The signatures
 * here put the position first on every helper so that cannot recur.
 */

/** Bake `color` into the vertex colors and hand the geometry back. */
export function coloured(
  geometry: THREE.BufferGeometry,
  color: THREE.Color,
): THREE.BufferGeometry {
  applyVertexColor(geometry, color);
  return geometry;
}

/**
 * A box with its base at `baseZ`, centered on (x, y), turned by `angle` about
 * its own center.
 */
export function propBox(
  x: number,
  y: number,
  baseZ: number,
  width: number,
  depth: number,
  height: number,
  color: THREE.Color,
  angle = 0,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, depth, height);
  if (angle) geometry.rotateZ(angle);
  geometry.translate(x, y, baseZ + height / 2);
  return coloured(geometry, color);
}

/** A vertical cylinder with its base at `baseZ`, centered on (x, y). */
export function propCylinder(
  x: number,
  y: number,
  baseZ: number,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  segments: number,
  color: THREE.Color,
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(
    radiusTop,
    radiusBottom,
    height,
    segments,
  );
  // CylinderGeometry stands along Y; this scene has Z up
  geometry.rotateX(Math.PI / 2);
  geometry.translate(x, y, baseZ + height / 2);
  return coloured(geometry, color);
}

export function propSphere(
  x: number,
  y: number,
  z: number,
  radius: number,
  color: THREE.Color,
): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, 8, 6);
  geometry.translate(x, y, z);
  return coloured(geometry, color);
}

/**
 * Merge a prop's parts into one geometry and dispose the sources. Null when the
 * merge fails, which is the caller's cue to drop the feature rather than push a
 * geometry with a mismatched attribute set into the tile.
 */
export function mergeParts(
  parts: THREE.BufferGeometry[],
): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  const merged = BufferGeometryUtils.mergeGeometries(parts);
  for (const part of parts) {
    // a merge of one geometry can hand it straight back; disposing that would
    // free the geometry the caller is about to use
    if (part !== merged) part.dispose();
  }
  return merged;
}

/**
 * The seeded quarter turn that keeps a row of identical props from looking
 * stamped. Deterministic per feature id, so a reload does not re-roll it.
 */
export function quarterTurn(id: Geojson.Feature["id"]): number {
  return (hashSeed(`${id}`) % 4) * (Math.PI / 2);
}

/** Turn a point prop about its own origin, then move it onto the feature. */
export function placeAt(
  geometry: THREE.BufferGeometry,
  x: number,
  y: number,
  angle: number,
): THREE.BufferGeometry {
  geometry.rotateZ(angle);
  geometry.translate(x, y, 0);
  return geometry;
}
