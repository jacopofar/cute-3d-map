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

// static, the zoom at which 3D tile data are stored; must match TILE_ZOOM in
// tilegen/main.py
export const TILE_ZOOM = 15;

export function epsg4326toEpsg3857(coordinates: [number, number]): [number, number] {
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
// trees are lit too, so they shade with the sun instead of being flat
const treeMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

// a road or rail line, kept as lng/lat so fleets can be placed against the
// current projection origin every frame (see VehicleManager)
export interface Road {
  id: string;
  highway?: string;
  // "yes" = one-way along the coordinate order, "-1" = against it
  oneway?: string;
  coordinates: [number, number][];
}

export interface TileObjects {
  meshes: THREE.Object3D[];
  roads: Road[];
  rails: Road[];
  stops: [number, number][];
}

export async function objectsAt(
  viewOrigin: [number, number],
  x: number,
  y: number,
): Promise<TileObjects> {
  // offset in meters of the origin
  const originMeters = epsg4326toEpsg3857(viewOrigin);
  // scaling factor
  const scaleFactor = Math.cos((2 * Math.PI * viewOrigin[1]) / 360);
  const response = await fetch(`tiles/${x}/${y}.json`);
  if (response.status === 404) {
    // tiles with no renderable features are not written at all, so a 404
    // means "nothing here" (treat as empty, don't retry forever)
    return { meshes: [], roads: [], rails: [], stops: [] };
  }
  if (!response.ok) {
    throw new Error(`failed to fetch tile ${x}/${y}: ${response.status}`);
  }
  let myGeoJSON: Geojson.FeatureCollection = await response.json();

  const byKind: Record<string, THREE.BufferGeometry[]> = {};
  const roads: Road[] = [];
  const rails: Road[] = [];
  const stops: [number, number][] = [];
  myGeoJSON.features.forEach((f, index) => {
    const cmtype = f.properties?.cmtype;
    if (cmtype === "road" || cmtype === "rail") {
      // not rendered; used as paths for the vehicle/train fleets
      const target = cmtype === "road" ? roads : rails;
      target.push(...roadsIn(f, `${x}/${y}/${index}`));
      return;
    }
    if (cmtype === "tram_stop" && f.geometry.type === "Point") {
      // tram stops the rail fleet pauses at
      stops.push(f.geometry.coordinates as [number, number]);
      return;
    }
    geoJSONtoGeometries(f, originMeters, scaleFactor).forEach(
      ({ kind, geometries }) => {
        (byKind[kind] ??= []).push(...geometries);
      },
    );
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
    } else {
      // mergeGeometries returns null when the geometries have mismatched
      // attributes; don't drop the tile without a trace
      console.warn(
        `could not merge ${geometries.length} ${kind} geometries in tile ${x}/${y}`,
      );
    }
  }
  return { meshes, roads, rails, stops };
}

function roadsIn(f: Geojson.Feature, idPrefix: string): Road[] {
  const highway = (f.properties?.highway as string | undefined) ?? undefined;
  const oneway = (f.properties?.oneway as string | undefined) ?? undefined;
  const geom = f.geometry;
  if (geom.type === "LineString") {
    return [
      {
        id: idPrefix,
        highway,
        oneway,
        coordinates: geom.coordinates as [number, number][],
      },
    ];
  }
  if (geom.type === "MultiLineString") {
    return geom.coordinates.map((coordinates, i) => ({
      id: `${idPrefix}/${i}`,
      highway,
      oneway,
      coordinates: coordinates as [number, number][],
    }));
  }
  return [];
}
