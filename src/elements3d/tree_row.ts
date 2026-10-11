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
    const totLength = turf.length(line);
    let ret: THREE.BufferGeometry[][] = [];
    for(let a = 0; a < totLength; a += 0.005){
      const p = turf.along(line, a);
      p.id = `${f.id}/${a}`;
      ret.push(tree(originMeters, scaleFactor, p))
    }
    return ret.flat(1);
  }

  throw Error(`Cannot have tree of type ${f.geometry.type}`);
}
