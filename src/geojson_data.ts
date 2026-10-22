import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";
import { building } from "./elements3d/building";
import { cemetery, cemeteryMaterial } from "./elements3d/cemetery";
import {
  crosswalk,
  crosswalkInfo,
  crosswalkMaterial,
  type CrosswalkInfo,
} from "./elements3d/crosswalk";
export type { CrosswalkInfo } from "./elements3d/crosswalk";
import {
  platform,
  platformInfo,
  platformMaterial,
  type PlatformInfo,
} from "./elements3d/platform";
export type { PlatformInfo } from "./elements3d/platform";
import { rail, railMaterial } from "./elements3d/rail";
import { parkedCarsFromRows, type ParkingRow } from "./parking_layout";
import { roadMarking, roadMarkingMaterial } from "./elements3d/road_marking";
import {
  construction,
  constructionInfo,
  constructionMaterial,
  type ConstructionInfo,
} from "./elements3d/construction";
export type { ConstructionInfo } from "./elements3d/construction";
import {
  fountain,
  fountainMaterial,
  fountainWaterMaterial,
} from "./elements3d/fountain";
import {
  metroSignMaterial,
  transitStop,
  transitStopMaterial,
} from "./elements3d/transit";
import { furniture, furnitureMaterial } from "./elements3d/furniture";
import { monument, monumentMaterial } from "./elements3d/monument";
import { playground, playgroundMaterial } from "./elements3d/playground";
import { terrace, terraceMaterial } from "./elements3d/terrace";
import { church, isChurch } from "./elements3d/church";
import { glassMaterial, isGlass } from "./elements3d/glass";
import { green, greenMaterial } from "./elements3d/green";
import { tree } from "./elements3d/tree";
import { treeMaterial as treeSurfaceMaterial } from "./elements3d/tree_material";
import { tree_row } from "./elements3d/tree_row";
import { water, waterMaterial } from "./elements3d/water";
import { bench } from "./elements3d/bench";
import { aeroway, aerowayMaterial } from "./elements3d/aeroway";
import { fence, fenceMaterial } from "./elements3d/fence";
import {
  bridge,
  tunnel,
  bridgeMaterial,
  tunnelMaterial,
} from "./elements3d/bridge";

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
  kind:
    | "building"
    | "glass"
    | "roof"
    | "church"
    | "tree"
    | "water"
    | "green"
    | "cemetery"
    | "furniture"
    | "fountain"
    | "fountain_water"
    | "transit_stop"
    | "metro_sign"
    | "terrace"
    | "playground"
    | "monument"
    | "construction"
    | "crosswalk"
    | "road_marking"
    | "platform"
    | "rail"
    | "aeroway"
    | "fence"
    | "bridge"
    | "tunnel"
    | "bench";
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
    // a curtain wall goes to its own kind so it can carry the glass material;
    // its roof stays a roof (glass towers have roofs too), and the church cross
    // below is unaffected
    const groups: {
      kind: "building" | "glass" | "roof" | "church";
      geometries: THREE.BufferGeometry[];
    }[] = [
      {
        kind: isGlass(f.properties) ? "glass" : "building",
        geometries: parts.map((part) => part.walls),
      },
    ];
    const roofs = parts
      .map((part) => part.roof)
      .filter((roof): roof is THREE.BufferGeometry => roof !== null);
    if (roofs.length > 0) groups.push({ kind: "roof", geometries: roofs });
    // a church's cross is its own kind too: the walls keep their (stony) look
    // and the checkbox hides just the ornament
    if (isChurch(f.properties)) {
      const crosses = church(originMeters, scaleFactor, buildingInfo(f));
      if (crosses.length > 0) {
        groups.push({ kind: "church", geometries: crosses });
      }
    }
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
  if (f.properties.cmtype === "bench") {
    return [{ kind: "bench", geometries: bench(originMeters, scaleFactor, f) }];
  }
  if (f.properties.cmtype === "green") {
    return [{ kind: "green", geometries: green(originMeters, scaleFactor, f) }];
  }
  if (f.properties.cmtype === "cemetery") {
    return [
      {
        kind: "cemetery",
        geometries: cemetery(originMeters, scaleFactor, f),
      },
    ];
  }
  if (f.properties.cmtype === "furniture") {
    return [
      {
        kind: "furniture",
        geometries: furniture(originMeters, scaleFactor, f),
      },
    ];
  }
  if (f.properties.cmtype === "fountain") {
    const { stone, water } = fountain(originMeters, scaleFactor, f);
    const groups: {
      kind: "fountain" | "fountain_water";
      geometries: THREE.BufferGeometry[];
    }[] = [{ kind: "fountain", geometries: stone }];
    if (water.length > 0) {
      groups.push({ kind: "fountain_water", geometries: water });
    }
    return groups;
  }
  if (f.properties.cmtype === "terrace") {
    return [
      {
        kind: "terrace",
        geometries: terrace(originMeters, scaleFactor, f),
      },
    ];
  }
  if (f.properties.cmtype === "playground") {
    return [
      {
        kind: "playground",
        geometries: playground(originMeters, scaleFactor, f),
      },
    ];
  }
  if (f.properties.cmtype === "monument") {
    return [
      {
        kind: "monument",
        geometries: monument(originMeters, scaleFactor, f),
      },
    ];
  }
  if (f.properties.cmtype === "construction") {
    return [
      {
        kind: "construction",
        geometries: construction(originMeters, scaleFactor, f),
      },
    ];
  }
  if (f.properties.cmtype === "crosswalk") {
    return [
      {
        kind: "crosswalk",
        geometries: crosswalk(originMeters, scaleFactor, f),
      },
    ];
  }
  if (f.properties.cmtype === "road_marking") {
    return [
      {
        kind: "road_marking",
        geometries: roadMarking(originMeters, scaleFactor, f),
      },
    ];
  }
  if (f.properties.cmtype === "platform") {
    return [
      {
        kind: "platform",
        geometries: platform(originMeters, scaleFactor, f),
      },
    ];
  }
  if (f.properties.cmtype === "rail") {
    return [{ kind: "rail", geometries: rail(originMeters, scaleFactor, f) }];
  }
  if (f.properties.cmtype === "transit_stop") {
    const { body, sign } = transitStop(originMeters, scaleFactor, f);
    const groups: {
      kind: "transit_stop" | "metro_sign";
      geometries: THREE.BufferGeometry[];
    }[] = [{ kind: "transit_stop", geometries: body }];
    if (sign.length > 0) groups.push({ kind: "metro_sign", geometries: sign });
    return groups;
  }
  if (f.properties.cmtype === "aeroway") {
    return [
      { kind: "aeroway", geometries: aeroway(originMeters, scaleFactor, f) },
    ];
  }
  if (f.properties.cmtype === "fence") {
    return [{ kind: "fence", geometries: fence(originMeters, scaleFactor, f) }];
  }
  if (f.properties.cmtype === "bridge") {
    return [
      { kind: "bridge", geometries: bridge(originMeters, scaleFactor, f) },
    ];
  }
  if (f.properties.cmtype === "tunnel") {
    return [
      { kind: "tunnel", geometries: tunnel(originMeters, scaleFactor, f) },
    ];
  }

  console.error("Cannot handle feature:", f);
  return [];
}

// one shared material per kind; per-feature colors are baked into vertex
// colors, so a whole tile renders in a single draw call per kind instead of
// one mesh per feature
const buildingMaterial = new THREE.MeshToonMaterial({ vertexColors: true });
// trees are lit too, so they shade with the sun instead of being flat; their
// material also carries the wind-sway vertex patch
const treeMaterial = treeSurfaceMaterial;
// benches are lit the same way, so their wood and metal shade
const benchMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
// the church ornament (a cross) is lit as well, and small enough that the
// toon material's banding would only make it flicker. A faint emissive gold
// keeps the cross legible when its faces are turned away from the sun, which
// is half of the bearings it is seen from.
const churchMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  emissive: 0x4a3a12,
});

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
  // the bottom of the volume; building parts can start above the ground
  base?: number;
  color?: string;
  name?: string;
  street?: string;
  housenumber?: string;
  // real, or filled in by tilegen from the dataset's own distribution
  roofShape?: string;
  roofColor?: string;
  // the fields tilegen sampled rather than read from a tag
  imputed: string[];
  // the OSM building value and, for a place of worship, its religion: what
  // isChurch() classifies on
  building?: string;
  religion?: string;
  // a tagged curtain wall: no windows, balconies or door, and the walls get
  // their own glass material (see elements3d/glass.ts)
  glass?: boolean;
}

// a street-furniture point, for click-picking + the OSM link
export interface PlaygroundInfo {
  id?: string;
  name?: string;
  lon: number;
  lat: number;
}

export interface MonumentInfo {
  id?: string;
  name?: string;
  kind: string;
  memorial?: string;
  lon: number;
  lat: number;
}

export interface TerraceInfo {
  id?: string;
  name?: string;
  kind: string;
  lon: number;
  lat: number;
}

export interface TransitInfo {
  id?: string;
  name?: string;
  kind: string;
  lon: number;
  lat: number;
}

export interface FountainInfo {
  id?: string;
  name?: string;
  lon: number;
  lat: number;
  size: number;
}

export interface FurnitureInfo {
  id?: string;
  kind: string;
  lon: number;
  lat: number;
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

// a runway centreline, carried out of a tile for the airplane layer (the plane
// paths are derived from the same line the surface is drawn from)
export interface RunwayLine {
  id: string;
  coords: [number, number][];
  width: number;
}

// an apron outline for the airplane layer, which parks static airliners on it
export interface ApronRing {
  id: string;
  ring: [number, number][];
}

// a static parked car: tilegen places the bays along the roads and emits the
// occupied ones with a model-space heading
export interface ParkedCar {
  lon: number;
  lat: number;
  heading: number;
}

// a street lamp point, for the night glow
export interface LampSpot {
  lon: number;
  lat: number;
}

export interface TileObjects {
  meshes: THREE.Object3D[];
  buildings: BuildingInfo[];
  water: WaterInfo[];
  furniture: FurnitureInfo[];
  fountains: FountainInfo[];
  transit: TransitInfo[];
  terraces: TerraceInfo[];
  playgrounds: PlaygroundInfo[];
  monuments: MonumentInfo[];
  construction: ConstructionInfo[];
  crosswalks: CrosswalkInfo[];
  platforms: PlatformInfo[];
  traffic: TrafficLoop[];
  // signals/crossings as [lon, lat]; the renderer matches them to the routes
  crossings: [number, number][];
  // traffic signals only, for the glowing signal heads at night
  signals: [number, number][];
  // runway centrelines; a runway spanning tiles repeats, deduped by id in main
  runways: RunwayLine[];
  // apron outlines, for the parked airliners; deduped by id in main
  aprons: ApronRing[];
  // parked cars, already assigned to this tile by tilegen
  parking: ParkedCar[];
  // street lamps, for the night glow
  lamps: LampSpot[];
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
    return {
      meshes: [],
      buildings: [],
      water: [],
      furniture: [],
      fountains: [],
      transit: [],
      terraces: [],
      playgrounds: [],
      monuments: [],
      construction: [],
      crosswalks: [],
      platforms: [],
      traffic: [],
      crossings: [],
      signals: [],
      runways: [],
      aprons: [],
      parking: [],
      lamps: [],
    };
  }
  // A dev server with a SPA fallback (Vite does this) answers a missing
  // /tiles/... path with index.html and a 200, so a permalink pointing outside
  // the generated set would otherwise blow up parsing HTML as JSON and retry on
  // every move. Not JSON means "nothing here" as far as the map is concerned.
  if (!(response.headers.get("content-type") ?? "").includes("json")) {
    console.warn(`tile ${x}/${y} is not JSON, treating it as empty`);
    return {
      meshes: [],
      buildings: [],
      water: [],
      furniture: [],
      fountains: [],
      transit: [],
      terraces: [],
      playgrounds: [],
      monuments: [],
      construction: [],
      crosswalks: [],
      platforms: [],
      traffic: [],
      crossings: [],
      signals: [],
      runways: [],
      aprons: [],
      parking: [],
      lamps: [],
    };
  }
  if (!response.ok) {
    throw new Error(`failed to fetch tile ${x}/${y}: ${response.status}`);
  }
  let myGeoJSON: Geojson.FeatureCollection = await response.json();

  const traffic = trafficIn(
    myGeoJSON as unknown as { traffic?: RawTrafficLoop[] },
  );
  const parking = parkingIn(
    myGeoJSON as unknown as { parking?: [number, number, number][] },
  );
  const lamps = lampsIn(myGeoJSON as unknown as { lamps?: [number, number][] });

  const byKind: Record<string, THREE.BufferGeometry[]> = {};
  const buildings: BuildingInfo[] = [];
  const water: WaterInfo[] = [];
  const furniture: FurnitureInfo[] = [];
  const fountains: FountainInfo[] = [];
  const transit: TransitInfo[] = [];
  const terraces: TerraceInfo[] = [];
  const playgrounds: PlaygroundInfo[] = [];
  const monuments: MonumentInfo[] = [];
  const construction: ConstructionInfo[] = [];
  const crosswalks: CrosswalkInfo[] = [];
  const platforms: PlatformInfo[] = [];
  const crossings: [number, number][] = [];
  const signals: [number, number][] = [];
  const runways: RunwayLine[] = [];
  const aprons: ApronRing[] = [];
  myGeoJSON.features.forEach((f) => {
    const cmtype = f.properties?.cmtype;
    if (cmtype === "traffic_signal" || cmtype === "crossing") {
      // not rendered, but the renderer detects when a car passes one and adds
      // a cosmetic speed bump
      if (f.geometry?.type === "Point") {
        const point = f.geometry.coordinates as [number, number];
        crossings.push(point);
        if (cmtype === "traffic_signal") signals.push(point);
      }
      return;
    }
    if (cmtype === "road" || cmtype === "tram_stop") {
      // the traffic routes are precomputed into `traffic`; older network
      // features are not rendered (the new `rail` cmtype is rendered below)
      return;
    }
    if (cmtype === "building") {
      buildings.push(buildingInfo(f));
    } else if (cmtype === "water") {
      water.push(waterInfo(f));
    } else if (cmtype === "furniture") {
      const info = furnitureInfo(f);
      if (info) furniture.push(info);
    } else if (cmtype === "fountain") {
      const info = fountainInfo(f);
      if (info) fountains.push(info);
    } else if (cmtype === "transit_stop") {
      const info = transitInfo(f);
      if (info) transit.push(info);
    } else if (cmtype === "terrace") {
      const info = terraceInfo(f);
      if (info) terraces.push(info);
    } else if (cmtype === "playground") {
      const info = playgroundInfo(f);
      if (info) playgrounds.push(info);
    } else if (cmtype === "monument") {
      const info = monumentInfo(f);
      if (info) monuments.push(info);
    } else if (cmtype === "construction") {
      const info = constructionInfo(f);
      if (info) construction.push(info);
    } else if (cmtype === "crosswalk") {
      const info = crosswalkInfo(f);
      if (info) crosswalks.push(info);
    } else if (cmtype === "platform") {
      const info = platformInfo(f);
      if (info) platforms.push(info);
    } else if (cmtype === "aeroway" && f.properties?.aeroway === "runway") {
      const runway = runwayInfo(f);
      if (runway) runways.push(runway);
    } else if (cmtype === "aeroway" && f.properties?.aeroway === "apron") {
      const apron = apronInfo(f);
      if (apron) aprons.push(apron);
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
          : kind === "glass"
            ? glassMaterial
            : kind === "church"
              ? churchMaterial
              : kind === "water"
                ? waterMaterial
                : kind === "green"
                  ? greenMaterial
                  : kind === "cemetery"
                    ? cemeteryMaterial
                    : kind === "furniture"
                      ? furnitureMaterial
                      : kind === "fountain"
                        ? fountainMaterial
                        : kind === "fountain_water"
                          ? fountainWaterMaterial
                          : kind === "transit_stop"
                            ? transitStopMaterial
                            : kind === "metro_sign"
                              ? metroSignMaterial()
                              : kind === "terrace"
                                ? terraceMaterial
                                : kind === "playground"
                                  ? playgroundMaterial
                                  : kind === "monument"
                                    ? monumentMaterial
                                    : kind === "construction"
                                      ? constructionMaterial
                                      : kind === "crosswalk"
                                        ? crosswalkMaterial
                                        : kind === "road_marking"
                                          ? roadMarkingMaterial
                                          : kind === "platform"
                                            ? platformMaterial
                                            : kind === "rail"
                                              ? railMaterial
                                              : kind === "aeroway"
                                                ? aerowayMaterial
                                                : kind === "fence"
                                                  ? fenceMaterial
                                                  : kind === "bridge"
                                                    ? bridgeMaterial
                                                    : kind === "tunnel"
                                                      ? tunnelMaterial
                                                      : kind === "bench"
                                                        ? benchMaterial
                                                        : treeMaterial;
      const mesh = new THREE.Mesh(merged, material);
      mesh.userData = { kind, tileKey: `${x}_${y}` };
      // The custom layer writes MapLibre's projection straight into
      // camera.projectionMatrix, so three's frustum planes are only approximately
      // right; a merged glass tile (the towers) has a big enough bounding sphere
      // to fall outside them and vanish. The tiles are already the spatial batch
      // and only a handful are loaded around the view, so skip the test.
      if (kind === "glass") mesh.frustumCulled = false;
      // flat ground layers and the fence shader do not cast sensible shadows
      // (the fence's gaps are a shader discard the depth pass cannot see)
      // keep the shadow casters to the big silhouettes: buildings, roofs and
      // trees carry the look, while every extra kind is another shadow draw
      // glass walls cast like any other wall: a tower without its shadow
      // silhouette would float over the street
      const casts =
        kind === "building" ||
        kind === "glass" ||
        kind === "roof" ||
        kind === "tree";
      mesh.castShadow = casts;
      // only the ground catcher receives: shadows on roofs and walls read as
      // artefacts at this stylised scale, while the ground shadows give the
      // scene its depth
      mesh.receiveShadow = false;
      meshes.push(mesh);
    } else {
      // mergeGeometries returns null when the geometries have mismatched
      // attributes; don't drop the tile without a trace
      console.warn(
        `could not merge ${geometries.length} ${kind} geometries in tile ${x}/${y}`,
      );
    }
  }
  return {
    meshes,
    buildings,
    water,
    furniture,
    fountains,
    transit,
    terraces,
    playgrounds,
    monuments,
    construction,
    crosswalks,
    platforms,
    traffic,
    crossings,
    signals,
    runways,
    aprons,
    parking,
    lamps,
  };
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
    base: Number(props.base) > 0 ? Number(props.base) : 0,
    color: props.color as string | undefined,
    name: props.name as string | undefined,
    street: props.street as string | undefined,
    housenumber: props.housenumber as string | undefined,
    roofShape: props.roof_shape as string | undefined,
    roofColor: props.roof_color as string | undefined,
    imputed: Array.isArray(props.imputed) ? (props.imputed as string[]) : [],
    building: props.building as string | undefined,
    religion: props.religion as string | undefined,
    // the flag, or the raw tags on a tile generated before it existed
    glass: isGlass(props),
  };
}

// a playground for click-picking + the OSM link
export function playgroundInfo(f: Geojson.Feature): PlaygroundInfo | null {
  const props = f.properties ?? {};
  const geom = f.geometry;
  if (geom.type !== "Point") return null;
  return {
    id: typeof f.id === "string" ? f.id : undefined,
    name: typeof props.name === "string" ? props.name : undefined,
    lon: geom.coordinates[0],
    lat: geom.coordinates[1],
  };
}

// a monument/memorial for click-picking + the OSM link
export function monumentInfo(f: Geojson.Feature): MonumentInfo | null {
  const props = f.properties ?? {};
  const kind = props.kind;
  if (typeof kind !== "string") return null;
  const geom = f.geometry;
  if (geom.type !== "Point") return null;
  return {
    id: typeof f.id === "string" ? f.id : undefined,
    name: typeof props.name === "string" ? props.name : undefined,
    kind,
    memorial: typeof props.memorial === "string" ? props.memorial : undefined,
    lon: geom.coordinates[0],
    lat: geom.coordinates[1],
  };
}

// an outdoor terrace for click-picking + the OSM link
export function terraceInfo(f: Geojson.Feature): TerraceInfo | null {
  const props = f.properties ?? {};
  const kind = props.terrace;
  if (typeof kind !== "string") return null;
  const geom = f.geometry;
  if (geom.type !== "Point") return null;
  return {
    id: typeof f.id === "string" ? f.id : undefined,
    name: typeof props.name === "string" ? props.name : undefined,
    kind,
    lon: geom.coordinates[0],
    lat: geom.coordinates[1],
  };
}

// a transit stop for click-picking + the OSM link
export function transitInfo(f: Geojson.Feature): TransitInfo | null {
  const props = f.properties ?? {};
  const kind = props.stop;
  if (typeof kind !== "string") return null;
  const geom = f.geometry;
  if (geom.type !== "Point") return null;
  return {
    id: typeof f.id === "string" ? f.id : undefined,
    name: typeof props.name === "string" ? props.name : undefined,
    kind,
    lon: geom.coordinates[0],
    lat: geom.coordinates[1],
  };
}

// a fountain point for click-picking + the OSM link; size is the basin's
// equivalent diameter in meters (the click ring uses it)
export function fountainInfo(f: Geojson.Feature): FountainInfo | null {
  const props = f.properties ?? {};
  const geom = f.geometry;
  if (geom.type !== "Point") return null;
  const size = Number(props.size);
  return {
    id: typeof f.id === "string" ? f.id : undefined,
    name: typeof props.name === "string" ? props.name : undefined,
    lon: geom.coordinates[0],
    lat: geom.coordinates[1],
    size: Number.isFinite(size) ? size : 2.4,
  };
}

// the point a furniture feature is picked at; tilegen emits Point, with a
// line/area fallback for older tiles
export function furnitureInfo(f: Geojson.Feature): FurnitureInfo | null {
  const props = f.properties ?? {};
  const kind = props.furniture;
  if (typeof kind !== "string") return null;
  const geom = f.geometry;
  let coord: [number, number] | null = null;
  if (geom.type === "Point") {
    coord = [geom.coordinates[0], geom.coordinates[1]];
  } else if (geom.type === "LineString" && geom.coordinates.length > 0) {
    const mid = geom.coordinates[Math.floor(geom.coordinates.length / 2)];
    coord = [mid[0], mid[1]];
  }
  if (!coord) return null;
  return {
    id: typeof f.id === "string" ? f.id : undefined,
    kind,
    lon: coord[0],
    lat: coord[1],
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

// a runway centreline for the airplane layer. `id` is optional in the data;
// tiles written by the current generator always carry one, so a missing id just
// drops the runway rather than risking two runways merging under one key.
export function runwayInfo(f: Geojson.Feature): RunwayLine | null {
  const geom = f.geometry;
  const coords: [number, number][] = [];
  if (geom.type === "LineString") {
    coords.push(...(geom.coordinates as [number, number][]));
  } else if (geom.type === "MultiLineString") {
    for (const line of geom.coordinates) {
      coords.push(...(line as [number, number][]));
    }
  } else {
    return null;
  }
  if (coords.length < 2 || typeof f.id !== "string") return null;
  const props = f.properties ?? {};
  return {
    id: f.id,
    coords,
    width: Number(props.width) > 0 ? Number(props.width) : 45,
  };
}

// an apron outline for the parked airliners. Only the outer ring is used (the
// planes sit on the stand area, not in a courtyard); a missing id drops the
// apron, as with runways.
export function apronInfo(f: Geojson.Feature): ApronRing | null {
  const geom = f.geometry;
  let ring: [number, number][] | undefined;
  if (geom.type === "Polygon") {
    ring = geom.coordinates[0] as [number, number][];
  } else if (geom.type === "MultiPolygon") {
    const first = geom.coordinates[0];
    if (first) ring = first[0] as [number, number][];
  }
  if (!ring || ring.length < 4 || typeof f.id !== "string") return null;
  return { id: f.id, ring };
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

// the parking block written by tilegen: authored rows, each with the kerb line,
// style and pitch. Older tiles still carry [lon, lat, heading] spots; keep
// reading them until a full regeneration has landed.
function parkingIn(document: {
  parking?: [number, number, number][] | ParkingRow[];
}): ParkedCar[] {
  const rows = document.parking;
  if (!Array.isArray(rows) || rows.length === 0) return [];
  if (Array.isArray(rows[0])) {
    return (rows as [number, number, number][]).map(([lon, lat, heading]) => ({
      lon,
      lat,
      heading,
    }));
  }
  const cars = parkedCarsFromRows(rows as ParkingRow[]);
  return cars.map(({ lon, lat, heading }) => ({ lon, lat, heading }));
}

// the lamp block written by tilegen: [lon, lat] per street lamp
function lampsIn(document: { lamps?: [number, number][] }): LampSpot[] {
  const spots = document.lamps;
  if (!Array.isArray(spots)) return [];
  return spots.map(([lon, lat]) => ({ lon, lat }));
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
