import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../geojson_data";
import { applyVertexColor } from "./vertex_color";

const generateHash = (s: string): number => {
  let hash = 0;
  for (const char of s) {
    hash = (hash << 5) - hash + char.charCodeAt(0);
    hash |= 0; // Constrain to 32bit integer
  }
  return Math.abs(hash);
};

const GREENS = [
  '#002000',
	'#00340e',
	'#106616',
  '#147d3b',
  '#0d8c42',
]

export function tree(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  if (f.geometry.type === "Point") {
    const h = generateHash(`${f.id}`);
    const geometry = new THREE.CylinderGeometry(0.5, 2.7, 2.2 + (h % 10) / 5.0, 5);
    const pos = toModelCoords(
      [f.geometry.coordinates[0], f.geometry.coordinates[1]],
      originMeters,
      scaleFactor,
    );
    geometry.rotateX(Math.PI / 2);
    geometry.translate(pos[0], pos[1], 2);
    applyVertexColor(geometry, new THREE.Color(GREENS[h % GREENS.length]));
    // ExtrudeGeometry (buildings) is non-indexed, cylinders are indexed:
    // make everything non-indexed so mergeGeometries can combine them
    return [geometry.toNonIndexed()];
  }

  throw Error(`Cannot have tree of type ${f.geometry.type}`);
}
