import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";
import { building } from "./elements3d/building";
import { tree } from "./elements3d/tree";
import { tree_row } from "./elements3d/tree_row";
import { water, waterMaterial } from "./elements3d/water";
import { fence, fenceMaterial } from "./elements3d/fence";

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
  imputedColors = true,
): {
  kind: "building" | "roof" | "tree" | "water" | "fence";
  geometries: THREE.BufferGeometry[];
}[] {
  if (!f.properties) {
    return [];
  }
  if (!f.properties.cmtype) {
    return [];
  }
  if (f.properties.cmtype === "building") {
    // the roof comes back as its own kind, so it can be switched off on its own
    const parts = building(originMeters, scaleFactor, f, imputedColors);
    const groups: {
      kind: "building" | "roof";
      geometries: THREE.BufferGeometry[];
    }[] = [{ kind: "building", geometries: parts.map((part) => part.walls) }];
    const roofs = parts
      .map((part) => part.roof)
      .filter((roof): roof is THREE.BufferGeometry => roof !== null);
    if (roofs.length > 0) groups.push({ kind: "roof", geometries: roofs });
    return groups;
  }
  if (f.properties.cmtype === "tree") {
    return [{ kind: "tree", geometries: tree(originMeters, scaleFactor, f) }];
  }
  if (f.properties.cmtype === "tree_row") {
    return [
      { kind: "tree", geometries: tree_row(originMeters, scaleFactor, f) },
    ];
  }
  if (f.properties.cmtype === "water") {
    return [{ kind: "water", geometries: water(originMeters, scaleFactor, f) }];
  }
  if (f.properties.cmtype === "fence") {
    return [{ kind: "fence", geometries: fence(originMeters, scaleFactor, f) }];
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

// one precomputed vehicle route piece. `t0`/`t1` are seconds into the loop's
// `period`; the piece is drawn while the phase is in [t0, t1). `times[i]` is
// the seconds from the run's start to `coords[i]` (times[0] is 0), so the
// speed may vary along the run. See tilegen/traffic.py.
export interface TrafficRun {
  t0: number;
  t1: number;
  coords: [number, number][];
  times: number[];
}

export interface TrafficVehicle {
  phase: number; // 0..1 offset along the loop
  color: number; // parsed from the tile's "rrggbb"
}

// a loop as stored in one tile: the pieces of it that fall in this tile, plus
// the vehicles on it. The same loop id appears in every tile it spans, with
// disjoint run sets; the renderer merges them.
export interface TrafficLoop {
  kind: "car" | "train";
  id: string;
  v: number; // cruise speed, m/s
  period: number; // seconds for one lap
  runs: TrafficRun[];
  vehicles: TrafficVehicle[];
}

// a building footprint for click-picking + info (outer rings only)
export interface BuildingInfo {
  // OSM feature id ("way/1234", "relation/56"), for the OSM link
  id?: string;
  rings: [number, number][][];
  height: number;
  color?: string;
  name?: string;
  street?: string;
  housenumber?: string;
  // real, or filled in by tilegen from the dataset's own distribution
  roofShape?: string;
  roofColor?: string;
  // the fields tilegen sampled rather than read from a tag
  imputed: string[];
}

// a water feature for click-picking + info. Areas carry their (clipped) outer
// rings; waterways carry their centrelines, in lon/lat.
export interface WaterInfo {
  id?: string;
  name?: string;
  kind: string;
  rings: [number, number][][];
  lines: [number, number][][];
}

export interface TileObjects {
  meshes: THREE.Object3D[];
  buildings: BuildingInfo[];
  water: WaterInfo[];
  traffic: TrafficLoop[];
  // signals/crossings as [lon, lat]; the renderer matches them to the routes
  crossings: [number, number][];
}

export async function objectsAt(
  viewOrigin: [number, number],
  x: number,
  y: number,
  // when false, a building color that tilegen had to impute is ignored (the
  // generator marks which fields it sampled, so nothing is guessed here)
  imputedColors = true,
): Promise<TileObjects> {
  // offset in meters of the origin
  const originMeters = epsg4326toEpsg3857(viewOrigin);
  // scaling factor
  const scaleFactor = Math.cos((2 * Math.PI * viewOrigin[1]) / 360);
  const response = await fetch(`tiles/${x}/${y}.json`);
  if (response.status === 404) {
    // tiles with no renderable features are not written at all, so a 404
    // means "nothing here" (treat as empty, don't retry forever)
    return { meshes: [], buildings: [], water: [], traffic: [], crossings: [] };
  }
  // A dev server with a SPA fallback (Vite does this) answers a missing
  // /tiles/... path with index.html and a 200, so a permalink pointing outside
  // the generated set would otherwise blow up parsing HTML as JSON and retry on
  // every move. Not JSON means "nothing here" as far as the map is concerned.
  if (!(response.headers.get("content-type") ?? "").includes("json")) {
    console.warn(`tile ${x}/${y} is not JSON, treating it as empty`);
    return { meshes: [], buildings: [], water: [], traffic: [], crossings: [] };
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
  const water: WaterInfo[] = [];
  const crossings: [number, number][] = [];
  myGeoJSON.features.forEach((f) => {
    const cmtype = f.properties?.cmtype;
    if (cmtype === "traffic_signal" || cmtype === "crossing") {
      // not rendered, but the renderer detects when a car passes one and adds
      // a cosmetic speed bump
      if (f.geometry?.type === "Point") {
        crossings.push(f.geometry.coordinates as [number, number]);
      }
      return;
    }
    if (cmtype === "road" || cmtype === "rail" || cmtype === "tram_stop") {
      // the traffic routes are precomputed into `traffic`; the network
      // features are not rendered (older tiles still carry them)
      return;
    }
    if (cmtype === "building") {
      buildings.push(buildingInfo(f));
    } else if (cmtype === "water") {
      water.push(waterInfo(f));
    }
    geoJSONtoGeometries(f, originMeters, scaleFactor, imputedColors).forEach(
      ({ kind, geometries }) => {
        (byKind[kind] ??= []).push(...geometries);
      },
    );
  });

  const meshes: THREE.Object3D[] = [];
  for (const [kind, geometries] of Object.entries(byKind)) {
    const merged = BufferGeometryUtils.mergeGeometries(geometries);
    if (merged) {
      const material =
        kind === "building"
          ? buildingMaterial
          : kind === "water"
            ? waterMaterial
            : kind === "fence"
              ? fenceMaterial
              : treeMaterial;
      const mesh = new THREE.Mesh(merged, material);
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
  return { meshes, buildings, water, traffic, crossings };
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
    id: typeof f.id === "string" ? f.id : undefined,
    rings,
    height: Number(props.height) > 0 ? Number(props.height) : 10,
    color: props.color as string | undefined,
    name: props.name as string | undefined,
    street: props.street as string | undefined,
    housenumber: props.housenumber as string | undefined,
    roofShape: props.roof_shape as string | undefined,
    roofColor: props.roof_color as string | undefined,
    imputed: Array.isArray(props.imputed) ? (props.imputed as string[]) : [],
  };
}

// a water feature for click-picking: areas contribute outer rings, waterways
// their centrelines. Exported so the picking shape is unit-tested.
export function waterInfo(f: Geojson.Feature): WaterInfo {
  const rings: [number, number][][] = [];
  const lines: [number, number][][] = [];
  const geom = f.geometry;
  if (geom.type === "Polygon") {
    rings.push(geom.coordinates[0] as [number, number][]);
  } else if (geom.type === "MultiPolygon") {
    for (const polygon of geom.coordinates) {
      rings.push(polygon[0] as [number, number][]);
    }
  } else if (geom.type === "LineString") {
    lines.push(geom.coordinates as [number, number][]);
  } else if (geom.type === "MultiLineString") {
    for (const line of geom.coordinates) {
      lines.push(line as [number, number][]);
    }
  }
  const props = f.properties ?? {};
  return {
    id: typeof f.id === "string" ? f.id : undefined,
    name: props.name as string | undefined,
    kind: typeof props.water === "string" ? props.water : "",
    rings,
    lines,
  };
}

// the traffic block as written by tilegen (colors are "rrggbb" strings there,
// because JSON has no integer colors)
interface RawTrafficLoop {
  kind: "car" | "train";
  id: string;
  v: number;
  period: number;
  runs: TrafficRun[];
  vehicles: { phase: number; color: string }[];
}

function trafficIn(document: { traffic?: RawTrafficLoop[] }): TrafficLoop[] {
  const loops = document.traffic;
  if (!Array.isArray(loops)) return [];
  return loops.map((loop) => ({
    kind: loop.kind,
    id: loop.id,
    v: loop.v,
    period: loop.period,
    runs: loop.runs,
    vehicles: loop.vehicles.map((vehicle) => ({
      phase: vehicle.phase,
      color: parseInt(vehicle.color, 16),
    })),
  }));
}
