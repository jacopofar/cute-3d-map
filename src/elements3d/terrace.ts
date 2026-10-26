import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import {
  coloured,
  mergeParts,
  placeAt,
  propBox,
  propCylinder,
  quarterTurn,
} from "./props";
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

// one umbrella with a table and three chairs, centered on (cx, 0)
function seating(parts: THREE.BufferGeometry[], umbrella: THREE.Color): void {
  parts.push(propCylinder(0, 0, 0, 0.05, 0.05, 2.1, 6, METAL));
  const canopy = new THREE.ConeGeometry(1.5, 0.45, 8);
  canopy.rotateX(Math.PI / 2);
  canopy.translate(0, 0, 2.28);
  parts.push(coloured(canopy, umbrella));

  parts.push(propCylinder(0, 0, 0.75, 0.45, 0.4, 0.05, 10, TABLE_WOOD));
  parts.push(propCylinder(0, 0, 0, 0.04, 0.04, 0.75, 5, METAL));
  parts.push(propCylinder(0, 0, 0, 0.22, 0.24, 0.04, 6, METAL));

  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2;
    const dx = Math.cos(angle) * 0.78;
    const dy = Math.sin(angle) * 0.78;
    const facing = angle + Math.PI / 2;
    parts.push(propBox(dx, dy, 0.43, 0.42, 0.42, 0.06, CHAIR, facing));
    // the back sits just outside the seat, facing the table
    parts.push(
      propBox(
        dx + Math.cos(angle) * 0.18,
        dy + Math.sin(angle) * 0.18,
        0.49,
        0.42,
        0.06,
        0.45,
        CHAIR,
        facing,
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

  const merged = mergeParts(parts);
  if (!merged) return [];
  const [x, y] = toModelCoords(
    [geometry.coordinates[0], geometry.coordinates[1]],
    originMeters,
    scaleFactor,
  );
  return [placeAt(merged, x, y, quarterTurn(f.id))];
}
