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

export function epsg4326toEpsg3857(
  coordinates: [number, number],
): [number, number] {
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
    return [
      { kind: "building", geometries: building(originMeters, scaleFactor, f) },
    ];
  }
  if (f.properties.cmtype === "tree") {
    return [{ kind: "tree", geometries: tree(originMeters, scaleFactor, f) }];
  }
  if (f.properties.cmtype === "tree_row") {
    return [
      { kind: "tree", geometries: tree_row(originMeters, scaleFactor, f) },
    ];
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

// a loop's geometry is stored once per loop (`coords`) with its base (no-signal)
// times; each vehicle carries the small list of signal `windows` that delay it,
// and the client materializes its times. See tilegen/traffic.py.
export interface TrafficRun {
  coords: [number, number][];
  times: number[];
}

export interface TrafficVehicle {
  phase: number; // 0..1 offset along the loop
  color: number; // parsed from the tile's "rrggbb"
  period: number; // the car's own lap time (waits differ per car)
  // per-run stops: `carry` is the wait accrued before the run, and `events`
  // are that run's `[stop base time, wait]` stops
  runs: { carry: number; events: number[][] }[];
}

// a loop as stored in one tile: the pieces of it that fall in this tile, plus
// the vehicles on it. The same loop id appears in every tile it spans, with
// disjoint run sets; the renderer merges them.
export interface TrafficLoop {
  kind: "car" | "train";
  id: string;
  period: number; // seconds for one lap
  runs: TrafficRun[];
  vehicles: TrafficVehicle[];
}

// a building footprint for click-picking + info (outer rings only)
export interface BuildingInfo {
  rings: [number, number][][];
  height: number;
  color?: string;
  name?: string;
  street?: string;
  housenumber?: string;
}

export interface TileObjects {
  meshes: THREE.Object3D[];
  buildings: BuildingInfo[];
  traffic: TrafficLoop[];
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
    return { meshes: [], buildings: [], traffic: [] };
  }
  if (!response.ok) {
    throw new Error(`failed to fetch tile ${x}/${y}: ${response.status}`);
  }
  let myGeoJSON: Geojson.FeatureCollection = await response.json();

  const traffic = trafficIn(
    myGeoJSON as unknown as { traffic?: RawTrafficLoop[] },
  );

  const byKind: Record<string, THREE.BufferGeometry[]> = {};
  const buildings: BuildingInfo[] = [];
  myGeoJSON.features.forEach((f) => {
    const cmtype = f.properties?.cmtype;
    if (cmtype === "road" || cmtype === "rail" || cmtype === "tram_stop") {
      // the traffic routes are precomputed into `traffic`; the network
      // features are not rendered (older tiles still carry them)
      return;
    }
    if (cmtype === "building") {
      buildings.push(buildingInfo(f));
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
      const mesh = new THREE.Mesh(
        merged,
        kind === "building" ? buildingMaterial : treeMaterial,
      );
      mesh.userData = { kind, tileKey: `${x}_${y}` };
      meshes.push(mesh);
    } else {
      // mergeGeometries returns null when the geometries have mismatched
      // attributes; don't drop the tile without a trace
      console.warn(
        `could not merge ${geometries.length} ${kind} geometries in tile ${x}/${y}`,
      );
    }
  }
  return { meshes, buildings, traffic };
}

function buildingInfo(f: Geojson.Feature): BuildingInfo {
  const rings: [number, number][][] = [];
  const geom = f.geometry;
  if (geom.type === "Polygon") {
    rings.push(geom.coordinates[0] as [number, number][]);
  } else if (geom.type === "MultiPolygon") {
    for (const polygon of geom.coordinates) {
      rings.push(polygon[0] as [number, number][]);
    }
  }
  const props = f.properties ?? {};
  return {
    rings,
    height: Number(props.height) > 0 ? Number(props.height) : 10,
    color: props.color as string | undefined,
    name: props.name as string | undefined,
    street: props.street as string | undefined,
    housenumber: props.housenumber as string | undefined,
  };
}

// the traffic block as written by tilegen (colors are "rrggbb" strings there,
// because JSON has no integer colors)
interface RawTrafficLoop {
  kind: "car" | "train";
  id: string;
  period: number;
  runs: TrafficRun[];
  vehicles: {
    phase: number;
    color: string;
    period: number;
    runs: { carry: number; events: number[][] }[];
  }[];
}

function trafficIn(document: { traffic?: RawTrafficLoop[] }): TrafficLoop[] {
  const loops = document.traffic;
  if (!Array.isArray(loops)) return [];
  return loops.map((loop) => ({
    kind: loop.kind,
    id: loop.id,
    period: loop.period,
    runs: loop.runs,
    vehicles: loop.vehicles.map((vehicle) => ({
      phase: vehicle.phase,
      color: parseInt(vehicle.color, 16),
      period: vehicle.period,
      runs: vehicle.runs,
    })),
  }));
}
