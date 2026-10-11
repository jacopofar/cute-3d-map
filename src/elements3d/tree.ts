import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
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

const TRUNK_COLOR = new THREE.Color('#6b4f2a');

export function tree(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  if (f.geometry.type === "Point") {
    const h = generateHash(`${f.id}`);
    const props = f.properties as { type?: string; size?: number } | null;
    // type/size come from the preprocessing; fall back to a hash for old data
    const treeType = props?.type ?? (h % 3 === 0 ? "conifer" : "broadleaf");
    const radius =
      props && typeof props.size === "number" && props.size > 0
        ? props.size
        : 1.3 + (h % 7) * 0.12;
    const pos = toModelCoords(
      [f.geometry.coordinates[0], f.geometry.coordinates[1]],
      originMeters,
      scaleFactor,
    );
    const trunkHeight = Math.max(1, radius * 0.8);
    const trunk = new THREE.CylinderGeometry(0.12, 0.16, trunkHeight, 5);
    trunk.rotateX(Math.PI / 2); // stand the cylinder up (Z is up here)
    trunk.translate(pos[0], pos[1], trunkHeight / 2);
    applyVertexColor(trunk, TRUNK_COLOR);

    // conifers are cones, broadleaf trees spheres, with the size from above
    const conifer = treeType === "conifer";
    const canopy = conifer
      ? new THREE.ConeGeometry(radius * 0.8, radius * 1.8, 6)
      : new THREE.SphereGeometry(radius, 6, 5);
    if (conifer) {
      const height = radius * 1.8;
      canopy.rotateX(Math.PI / 2);
      canopy.translate(pos[0], pos[1], trunkHeight + height / 2);
    } else {
      canopy.translate(pos[0], pos[1], trunkHeight + radius * 0.9);
    }
    applyVertexColor(canopy, new THREE.Color(GREENS[h % GREENS.length]));

    // mergeGeometries wants matching attributes; non-indexed avoids the
    // indexed/non-indexed mismatch with other kinds
    const merged = BufferGeometryUtils.mergeGeometries([
      trunk.toNonIndexed(),
      canopy.toNonIndexed(),
    ]);
    return [merged ?? trunk.toNonIndexed()];
  }

  throw Error(`Cannot have tree of type ${f.geometry.type}`);
}
