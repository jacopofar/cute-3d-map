import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { applyVertexColor } from "./vertex_color";

const generateHash = (s: string): number => {
  let hash = 0;
  for (const char of s) {
    hash = (hash << 5) - hash + char.charCodeAt(0);
    hash |= 0; // Constrain to 32bit integer
  }
  return Math.abs(hash);
};

// medium greens: the darker end of the range used to come out black once the
// vertex color was multiplied by the lighting and ACES tone mapping
const GREENS = ["#2f7a33", "#3d8c3a", "#4a9a45", "#2c8a5b", "#5aa63f"];

const TRUNK_COLOR = new THREE.Color("#6b4f2a");

export interface CanopyVariation {
  /** multiplier on the canopy radius (and therefore its width) */
  radiusScale: number;
  /** vertical squash of the broadleaf sphere, about its center */
  squash: number;
}

// Deterministic crown variation from the per-tree hash. Kept tiny on purpose:
// enough to break up a row of cloned spheres, not enough to look deformed at
// street level. Exported so the ranges can be unit-tested without building
// geometry.
export function canopyVariation(hash: number): CanopyVariation {
  const a = ((hash >>> 11) % 1000) / 1000;
  const b = ((hash >>> 21) % 1000) / 1000;
  return { radiusScale: 0.9 + a * 0.22, squash: 0.82 + b * 0.3 };
}

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
    // open-ended: the top cap is inside the canopy and the bottom cap sits on
    // the ground, so both are invisible and would only add triangles
    const trunk = new THREE.CylinderGeometry(
      0.12,
      0.16,
      trunkHeight,
      5,
      1,
      true,
    );
    trunk.rotateX(Math.PI / 2); // stand the cylinder up (Z is up here)
    trunk.translate(pos[0], pos[1], trunkHeight / 2);
    applyVertexColor(trunk, TRUNK_COLOR);

    // conifers are cones, broadleaf trees spheres, with the size from above.
    // Segment counts are deliberately low: at map zooms the canopy is a few
    // pixels across, and trees are by far the most numerous object, so each
    // extra ring costs its triangles thousands of times over.
    const conifer = treeType === "conifer";
    // Broadleaf crowns get a little shape variety from the same per-tree hash,
    // so a boulevard does not look cloned without paying for more segments:
    // squash the sphere vertically and nudge its radius. The conifer stays as
    // it is, a cone already reads as a different tree.
    const variation = conifer ? undefined : canopyVariation(h);
    const canopyRadius = radius * (variation?.radiusScale ?? 1);
    const squash = variation?.squash ?? 1;
    const canopy = conifer
      ? new THREE.ConeGeometry(radius * 0.8, radius * 1.8, 5)
      : new THREE.SphereGeometry(canopyRadius, 5, 4);
    if (variation) canopy.scale(1, 1, squash);
    if (conifer) {
      const height = radius * 1.8;
      canopy.rotateX(Math.PI / 2);
      canopy.translate(pos[0], pos[1], trunkHeight + height / 2);
    } else {
      // keep the canopy bottom below the trunk top: the sphere squashes about
      // its center, so the center has to follow the squash or the junction
      // would open up on a flat crown
      canopy.translate(
        pos[0],
        pos[1],
        trunkHeight + canopyRadius * squash * 0.9,
      );
    }
    const canopyColor = new THREE.Color(GREENS[h % GREENS.length]);
    // vary the tone with the crown size: bigger crowns lean lighter/yellower,
    // smaller ones deeper, which stops a row of identical greens looking flat
    const tone = variation ? (variation.radiusScale - 0.9) / 0.22 : 0.5;
    canopyColor.offsetHSL(
      (tone - 0.5) * 0.03,
      (tone - 0.5) * 0.06,
      (tone - 0.5) * 0.07,
    );
    applyVertexColor(canopy, canopyColor);

    // merge trunk + canopy, keeping the index: un-indexing tripled the vertex
    // count for no rendering benefit (the attributes are identical, so the two
    // primitives merge fine)
    const merged = BufferGeometryUtils.mergeGeometries([trunk, canopy]);
    return [merged ?? trunk];
  }

  throw Error(`Cannot have tree of type ${f.geometry.type}`);
}
