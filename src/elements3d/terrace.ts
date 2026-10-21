import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";

import { toModelCoords } from "../geojson_data";
import { applyVertexColor } from "./vertex_color";
import { hashSeed } from "./random";

/*
 * Outdoor seating: a small terrace of umbrellas, tables and chairs where OSM
 * says a cafe/restaurant/bar seats people outside. The geometry is procedural;
 * tilegen only carries the point, the amenity (for the popup label) and the
 * name. A terrace is a handful of cylinders, cones and boxes merged into one
 * Lambert mesh per tile, so the whole layer is one draw call per tile.
 */

const UMBRELLA_COLORS = [
  new THREE.Color("#e8dcc0"),
  new THREE.Color("#a33a32"),
  new THREE.Color("#3f6b4a"),
  new THREE.Color("#3d5e7a"),
];
const TABLE_WOOD = new THREE.Color("#8a5a33");
const CHAIR = new THREE.Color("#3d3a34");
const METAL = new THREE.Color("#6f757c");

export const terraceMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

function coloured(
  geometry: THREE.BufferGeometry,
  color: THREE.Color,
): THREE.BufferGeometry {
  applyVertexColor(geometry, color);
  return geometry;
}

function cylinder(
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

function box(
  cx: number,
  cy: number,
  baseZ: number,
  width: number,
  depth: number,
  height: number,
  angle: number,
  color: THREE.Color,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, depth, height);
  geometry.rotateZ(angle);
  geometry.translate(cx, cy, baseZ + height / 2);
  return coloured(geometry, color);
}

// one umbrella with a table and three chairs, centered on (cx, 0)
function seating(parts: THREE.BufferGeometry[], umbrella: THREE.Color): void {
  parts.push(cylinder(0.05, 0.05, 2.1, 0, 6, METAL));
  const canopy = new THREE.ConeGeometry(1.5, 0.45, 8);
  canopy.rotateX(Math.PI / 2);
  canopy.translate(0, 0, 2.28);
  parts.push(coloured(canopy, umbrella));

  parts.push(cylinder(0.45, 0.4, 0.05, 0.75, 10, TABLE_WOOD));
  parts.push(cylinder(0.04, 0.04, 0.75, 0, 5, METAL));
  parts.push(cylinder(0.22, 0.24, 0.04, 0, 6, METAL));

  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2;
    const dx = Math.cos(angle) * 0.78;
    const dy = Math.sin(angle) * 0.78;
    const facing = angle + Math.PI / 2;
    parts.push(box(dx, dy, 0.43, 0.42, 0.42, 0.06, facing, CHAIR));
    // the back sits just outside the seat, facing the table
    parts.push(
      box(
        dx + Math.cos(angle) * 0.18,
        dy + Math.sin(angle) * 0.18,
        0.49,
        0.42,
        0.06,
        0.45,
        facing,
        CHAIR,
      ),
    );
  }
}

/** The geometry for one outdoor terrace point, centered on the feature. */
export function terrace(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const geometry = f.geometry;
  if (geometry.type !== "Point") {
    throw Error(`Cannot have terrace of type ${geometry.type}`);
  }
  const seed = hashSeed(`${f.id}`);
  const parts: THREE.BufferGeometry[] = [];
  const color = UMBRELLA_COLORS[seed % UMBRELLA_COLORS.length];
  const count = seed % 3 === 0 ? 2 : 1;

  for (let i = 0; i < count; i++) {
    const before = parts.length;
    seating(parts, color);
    const shift = count === 1 ? 0 : i === 0 ? -1.3 : 1.3;
    for (let j = before; j < parts.length; j++) {
      parts[j].translate(shift, 0, 0);
    }
  }

  const merged = BufferGeometryUtils.mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (!merged) return [];
  const [x, y] = toModelCoords(
    [geometry.coordinates[0], geometry.coordinates[1]],
    originMeters,
    scaleFactor,
  );
  merged.rotateZ((seed % 4) * (Math.PI / 2));
  merged.translate(x, y, 0);
  return [merged];
}
