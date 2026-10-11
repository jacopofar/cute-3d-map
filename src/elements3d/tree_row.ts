import * as THREE from "three";
import type Geojson from "geojson";
import * as turf from "@turf/turf";

import {tree} from "./tree";

export function tree_row(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  if (f.geometry.type === "LineString") {
    const line = turf.lineString(f.geometry.coordinates);
    // be explicit about units: turf defaults to kilometers, so the spacing
    // would silently depend on that default
    const totLength = turf.length(line, { units: "meters" });
    let ret: THREE.BufferGeometry[][] = [];
    for (let a = 0; a < totLength; a += 5) {
      const p = turf.along(line, a, { units: "meters" });
      p.id = `${f.id}/${a}`;
      // every tree in a row shares the row's type/size (from the preprocessing)
      p.properties = {
        cmtype: "tree",
        type: f.properties?.type,
        size: f.properties?.size,
      };
      ret.push(tree(originMeters, scaleFactor, p));
    }
    return ret.flat(1);
  }

  throw Error(`Cannot have tree of type ${f.geometry.type}`);
}
