import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";
import { building } from "./elements3d/building";
import { tree } from "./elements3d/tree";
import { tree_row } from "./elements3d/tree_row";

// square building with an hole, to test this kind of shape and highlight skew
// import myGeoJSON from './bicocca_hole.json';
// in Berlin, east side
// import myGeoJSON from './lichtenberg.json';
// reichstag
// import myGeoJSON from './reichstag.json';
// import myGeoJSON from './liberty_statue.json';
// import myGeoJSON from './capetown_lighthouse.json';
// import myGeoJSON from './montevideo_stadium_part.json';
// import myGeoJSON from './canada_far_north_building.json';
// import myGeoJSON from './tokyo_imperial_palace.json';
// import myGeoJSON from './santa_monica_rand.json';
// import myGeoJSON from './quito_colegio.json';
// import _myGeoJSON from "./11721.json";

// static, the zoom at which 3D tile data are stored
export const TILE_ZOOM = 15;

function epsg4326toEpsg3857(coordinates: [number, number]): [number, number] {
  let x = (coordinates[0] * 20037508.34) / 180;
  let y =
    Math.log(Math.tan(((90 + coordinates[1]) * Math.PI) / 360)) /
    (Math.PI / 180);
  y = (y * 20037508.34) / 180;
  return [x, y];
}

// Milan, Italy
// const scaleFactor = 0.70;
// Berlin, Germany
// const scaleFactor = 0.608;
// New York
// const scaleFactor = 0.758;
// Cape Town, SA + Montevideo
// const scaleFactor = 0.82835;
// northern Canada
// const scaleFactor = 0.549;
// Tokyo
// const scaleFactor = 0.812;
// Quito (close to Equator)
// const scaleFactor =  1.000;

export function toModelCoords(
  coord: [number, number],
  originMeters: [number, number],
  scaleFactor: number,
): [number, number] {
  const coordMeters = epsg4326toEpsg3857(coord);
  return [
    (coordMeters[0] - originMeters[0]) * scaleFactor,
    (coordMeters[1] - originMeters[1]) * scaleFactor,
  ];
}

export function geoJSONtoGeometries(
  f: Geojson.Feature,
  originMeters: [number, number],
  scaleFactor: number,
): { kind: "building" | "tree"; geometries: THREE.BufferGeometry[] }[] {
  if (!f.properties) {
    return [];
  }
  if (!f.properties.cmtype) {
    return [];
  }
  if (f.properties.cmtype === "building") {
    return [{ kind: "building", geometries: building(originMeters, scaleFactor, f) }];
  }
  if (f.properties.cmtype === "tree") {
    return [{ kind: "tree", geometries: tree(originMeters, scaleFactor, f) }];
  }
  if (f.properties.cmtype === "tree_row") {
    return [{ kind: "tree", geometries: tree_row(originMeters, scaleFactor, f) }];
  }

  console.error("Cannot handle feature:", f);
  return [];
}

// one shared material per kind; per-feature colors are baked into vertex
// colors, so a whole tile renders in a single draw call per kind instead of
// one mesh per feature
const buildingMaterial = new THREE.MeshToonMaterial({ vertexColors: true });
const treeMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });

export async function objectsAt(
  viewOrigin: [number, number],
  x: number,
  y: number,
): Promise<THREE.Object3D[]> {
  // offset in meters of the origin
  const originMeters = epsg4326toEpsg3857(viewOrigin);
  // scaling factor
  const scaleFactor = Math.cos((2 * Math.PI * viewOrigin[1]) / 360);
  let myGeoJSON: Geojson.FeatureCollection = await (
    await fetch(`tiles/${x}/${y}.json`)
  ).json();

  const byKind: Record<string, THREE.BufferGeometry[]> = {};
  myGeoJSON.features
    .flatMap((f) => geoJSONtoGeometries(f, originMeters, scaleFactor))
    .forEach(({ kind, geometries }) => {
      (byKind[kind] ??= []).push(...geometries);
    });

  const meshes: THREE.Object3D[] = [];
  for (const [kind, geometries] of Object.entries(byKind)) {
    const merged = BufferGeometryUtils.mergeGeometries(geometries);
    if (merged) {
      meshes.push(
        new THREE.Mesh(
          merged,
          kind === "building" ? buildingMaterial : treeMaterial,
        ),
      );
    }
  }
  return meshes;
}
