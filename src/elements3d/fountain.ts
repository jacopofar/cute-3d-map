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
 * The parts are merged into one Lambert mesh per fountain and the tile merges
 * those, so a fountain costs one draw call per tile. The water is a still blue
 * disc rather than the canal shader: it is small, and a second material would
 * split the mesh. An animated jet is the obvious next step.
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

/** The geometry for one fountain point, or empty for an unusable feature. */
export function fountain(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
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

  const parts: THREE.BufferGeometry[] = [];
  parts.push(column(radius, radius * 1.04, 0.35, 0, 12, STONE_DARK));
  // a raised coping ring, so the basin edge reads at street level
  const rim = new THREE.TorusGeometry(radius * 0.98, 0.09, 4, 16);
  rim.translate(0, 0, 0.37);
  parts.push(coloured(rim, STONE));
  // the water sits just above the stone top, inside the coping
  const surface = new THREE.CircleGeometry(radius * 0.86, 12);
  surface.translate(0, 0, 0.36);
  parts.push(coloured(surface, WATER));

  if (radius > 1.1) {
    parts.push(column(0.18, 0.24, 0.9, 0.36, 8, STONE));
    parts.push(column(0.5, 0.4, 0.14, 1.26, 10, STONE_DARK));
    const bowl = new THREE.CircleGeometry(0.42, 10);
    bowl.translate(0, 0, 1.34);
    parts.push(coloured(bowl, WATER));
    parts.push(column(0.035, 0.06, 0.5, 1.34, 6, JET));
  } else {
    parts.push(column(0.03, 0.05, 0.35, 0.36, 6, JET));
  }

  const merged = BufferGeometryUtils.mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (!merged) return [];

  const [x, y] = toModelCoords(
    [geometry.coordinates[0], geometry.coordinates[1]],
    originMeters,
    scaleFactor,
  );
  merged.rotateZ((hashSeed(`${f.id}`) % 4) * (Math.PI / 2));
  merged.translate(x, y, 0);
  return [merged];
}
