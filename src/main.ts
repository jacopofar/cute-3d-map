import {
  GeolocateControl,
  Map as MapLibreMap,
  MercatorCoordinate,
  NavigationControl,
  Popup,
  ScaleControl,
} from "maplibre-gl";
import * as THREE from "three";
import type Geojson from "geojson";
import "./maplibre_setup";

import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { building } from "./elements3d/building.ts";
// import {VRButton} from 'three/addons/webxr/VRButton.js';

import type { CustomLayerInterface, LngLat } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import {
  objectsAt,
  TILE_ZOOM,
  epsg4326toEpsg3857,
  toModelCoords,
} from "./geojson_data.ts";
import type {
  ApronRing,
  BarrierInfo,
  BuildingInfo,
  ConstructionInfo,
  CrosswalkInfo,
  FountainInfo,
  FurnitureInfo,
  MonumentInfo,
  PlatformInfo,
  PlaygroundInfo,
  RooftopInfo,
  TerraceInfo,
  TransitInfo,
  LampSpot,
  ParkedCar,
  RunwayLine,
  TrafficLoop,
  WaterInfo,
} from "./geojson_data.ts";
import {
  TrafficRenderer,
  BUS_TRAFFIC,
  CAR_TRAFFIC,
  TRAIN_TRAFFIC,
  TRAM_TRAFFIC,
} from "./traffic.ts";
import { ParkedCarLayer, type ParkedTile } from "./parked_cars.ts";
import { NightLights, type NightLightTile } from "./night_lights.ts";
import { DrivingCar } from "./driving_car.ts";
import {
  headingFromBearing,
  headingToBearing,
  pointAhead,
  type DriveInput,
  type DriveState,
} from "./driving.ts";
import {
  boxesOverlap,
  carRectangle,
  lineIntersectsRect,
  ringIntersectsRect,
} from "./collision.ts";
import { BloomPass } from "./bloom.ts";
import { CloudLayer } from "./clouds.ts";
import { PlaneLayer } from "./airplanes.ts";
import {
  facadeMaterial,
  tileFacadeDetail,
  windowMaterial,
} from "./elements3d/facade.ts";
import { crosswalkMaterial } from "./elements3d/crosswalk.ts";
import { fountainWaterMaterial } from "./elements3d/fountain.ts";
import { glassMaterial } from "./elements3d/glass.ts";
import { roadMarkingMaterial } from "./elements3d/road_marking.ts";
import { greenMaterial } from "./elements3d/green.ts";
import {
  cameraCenter,
  waterMaterial,
  waterwayWidth,
} from "./elements3d/water.ts";
import { treeSway } from "./elements3d/tree_material.ts";
import {
  DAY_HOUR,
  NIGHT_HOUR,
  currentMilanSolarHour,
  lerpColor,
  lightingAt,
  type Lighting,
} from "./daynight.ts";

// Import our custom CSS
// import "./scss/styles.scss";

import "./map_style.css";

// precomputed vehicles are only shown when the map is at least this zoomed in
const VEHICLE_MIN_ZOOM = 15;
// windows and doors are fine detail: only worth building once the map is close
// enough for them to read, and only for the tiles around the centre (the tile
// window itself is fixed by TILE_ZOOM, so at high zoom most loaded tiles are
// off-screen)
const FACADE_MIN_ZOOM = 17;
const FACADE_TILE_MARGIN = 1;
// fences are just over a meter tall, so below this zoom a band is under a pixel
// and reads as a jagged line; the fragment discard is cheap but not free over
// the whole city, so show them where they read (measured: posts and rails from
// 19, a dotted line at 18, noise at 17)
const FENCE_MIN_ZOOM = 18;
// sidewalks are a street-level detail; the slabs are cheap but there are many
const SIDEWALK_MIN_ZOOM = 16;
// car mode: a chase camera, high enough to read the street but flat enough to
// see the road ahead. The map center sits a little ahead of the car so the car
// is in the lower half of the screen instead of dead center. Zoom 20 puts a
// 2.7 m car at roughly 25 px, large enough to read as a car rather than a dot.
const DRIVE_ZOOM = 20;
const DRIVE_PITCH = 55;
const DRIVE_LOOK_AHEAD = 18;
// The camera jumps every frame, which keeps the map "moving", so the debounced
// move handler never fires while driving. The tile pass runs on its own slower
// clock instead, and the 2 km shadow cascade can afford to follow even less.
const DRIVE_TILE_PASS_MS = 350;
const DRIVE_SHADOW_MS = 1600;
const DRIVE_HUD_MS = 100;
// The car collides as a rectangle with a few centimeters of clearance, so the
// paint does not graze a wall. A building part whose base is above this is an
// overhead volume (a cantilevered floor) and does not block the car.
const DRIVE_CAR_MARGIN = 0.15;
const DRIVE_CLEARANCE = 1.6;
// keys held for driving; arrow keys are offered next to WASD because they do
// not collide with anything else on the page
const DRIVE_KEY_SET = new Set([
  "w",
  "a",
  "s",
  "d",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
]);

// MapTiler basemap styles. The map opens on the day style and swaps to the dark
// one at night, so the bright basemap does not clash with the dark 3D scene.
// this is beautiful but covers 3D feature by hovering or something
// const BASEMAP_DAY = "aquarelle-v4";
const BASEMAP_DAY = "basic-v2";
const BASEMAP_NIGHT = "basic-v2-dark";
const basemapStyleUrl = (name: string): string =>
  `https://api.maptiler.com/maps/${name}/style.json?key=${import.meta.env.VITE_MAPTILER_KEY}`;
// An empty style keeps the 3D custom layer without the MapTiler canvas. The
// page background shows through where the basemap used to be.
const EMPTY_BASEMAP_STYLE = { version: 8 as const, sources: {}, layers: [] };
// the night/day boundary that decides which basemap to show (the lighting model
// fades smoothly, but a style can only be one or the other)
const BASEMAP_NIGHT_AT = 0.5;
// below this night factor the pass is off: the lamps are hidden and a bloom
// over a daylight scene would only wash out the roofs
const BLOOM_NIGHT_AT = 0.35;

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] ?? c);
}

// the OSM page for a feature id like "way/1234" (tilegen writes those ids as-is)
const FURNITURE_LABELS: Record<string, string> = {
  bollard: "Bollard",
  bin: "Waste basket",
  bike_rack: "Bicycle parking",
  post_box: "Post box",
  drinking_water: "Drinking fountain",
  info_board: "Information board",
  hydrant: "Fire hydrant",
};

function osmLink(id: string | undefined): string | null {
  if (!id || !/^(node|way|relation)\/\d+$/.test(id)) return null;
  const url = `https://www.openstreetmap.org/${id}`;
  return `${escapeHtml(id)} (<a href="${url}" target="_blank" rel="noopener">OSM</a>)`;
}

// ray-cast point-in-polygon, in model space
function ringContains(
  ring: [number, number][],
  point: THREE.Vector3,
  originMeters: [number, number],
  scaleFactor: number,
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = toModelCoords(ring[i], originMeters, scaleFactor);
    const b = toModelCoords(ring[j], originMeters, scaleFactor);
    const crosses =
      a[1] > point.y !== b[1] > point.y &&
      point.x < ((b[0] - a[0]) * (point.y - a[1])) / (b[1] - a[1]) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

// distance (m) from a model-space point to a ring, used as a picking fallback.
// With closed=false it measures to an open polyline instead (a waterway
// centreline), so the last point does not connect back to the first.
function ringDistance(
  ring: [number, number][],
  point: THREE.Vector3,
  originMeters: [number, number],
  scaleFactor: number,
  closed = true,
): number {
  let best = Infinity;
  const count = ring.length;
  const segments = closed ? count : count - 1;
  for (let i = 0; i < segments; i++) {
    const a = toModelCoords(ring[i], originMeters, scaleFactor);
    const b = toModelCoords(ring[(i + 1) % count], originMeters, scaleFactor);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t =
      len2 > 0
        ? Math.max(
            0,
            Math.min(1, ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / len2),
          )
        : 0;
    const px = a[0] + t * dx;
    const py = a[1] + t * dy;
    best = Math.min(best, Math.hypot(point.x - px, point.y - py));
  }
  return best;
}

// Milan
// const tileCenter: [number, number] = [9.186, 45.497];
// Berlin
// const tileCenter: [number, number] = [13.52222, 52.51051];
// New York
// const tileCenter: [number, number] = [-73.908546, 40.609459];
// Cape Town
// const tileCenter: [number, number] = [18.446337, -33.979250];
// Montevideo, Uruguay (latitude copied from Cape Town)
// const tileCenter: [number, number] = [-56.21316, -33.979250];
// northern Canada
// const tileCenter: [number, number] = [-111.23443, 56.68004];
// Tokyo
// const tileCenter: [number, number] = [139.8678, 35.6189];
// santa monica (opposite latitude as cape town)
// const tileCenter: [number, number] = [-119.018, 33.877];
// Quito (on equator)
// const tileCenter: [number, number] = [-78.501, -0.18];

interface ThreeJSLayerInterface extends CustomLayerInterface {
  camera: THREE.Camera;
  scene: THREE.Scene;
  renderer?: THREE.WebGLRenderer;
  map: MapLibreMap;
}

function getTileIndex(point: { lng: number; lat: number }): [number, number] {
  const lon2tile = (lon: number) =>
    Math.floor(((lon + 180) / 360) * Math.pow(2, TILE_ZOOM));
  const lat2tile = (lat: number) =>
    Math.floor(
      ((1 -
        Math.log(
          Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180),
        ) /
          Math.PI) /
        2) *
        Math.pow(2, TILE_ZOOM),
    );

  return [lon2tile(point.lng), lat2tile(point.lat)];
}

// the browser name is enough for the perf report; the full UA string is noisy
// and the payload is meant to be grouped, not fingerprinted
function browserName(): string {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Unknown";
}

function webGPUSupported(): boolean {
  // WebGPU is exposed as navigator.gpu; the property is absent on browsers that
  // only implement WebGL
  return "gpu" in navigator;
}

// The layers menu owns every checkbox, but the night and inspect switches are
// outside it; collect all of them by id so the report always matches the DOM.
function checkboxStates(): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  document
    .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    .forEach((input, index) => {
      const label = input.closest("label");
      states[label?.id || input.id || `checkbox-${index}`] = input.checked;
    });
  return states;
}

// Build-time opt-in: without an endpoint the reporting path is a no-op and no
// request leaves the page. Both names are accepted so an existing .env with
// either spelling keeps working.
const PERF_ENDPOINT = String(
  import.meta.env.PERF_ENDPOINT ?? import.meta.env.VITE_PERF_ENDPOINT ?? "",
).trim();

const CHECKBOX_COOKIE = "map-checkboxes";
const CHECKBOX_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function readCheckboxCookie(): Record<string, boolean> {
  const prefix = `${CHECKBOX_COOKIE}=`;
  const entry = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  if (!entry) return {};
  try {
    const parsed: unknown = JSON.parse(
      decodeURIComponent(entry.slice(prefix.length)),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([key, value]) => key.length > 0 && typeof value === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

function restoreCheckboxStates() {
  for (const [id, checked] of Object.entries(readCheckboxCookie())) {
    const label = document.getElementById(id);
    const input = label?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (input) input.checked = checked;
  }
}

function saveCheckboxStates() {
  const value = encodeURIComponent(JSON.stringify(checkboxStates()));
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CHECKBOX_COOKIE}=${value}; Max-Age=${CHECKBOX_COOKIE_MAX_AGE}; Path=/; SameSite=Lax${secure}`;
}

class CoolMap {
  tileCenter: [number, number];
  map: MapLibreMap;
  private customLayer: ThreeJSLayerInterface;
  private loadedTiles: { [key: string]: THREE.Object3D[] } = {};
  // precomputed loops per loaded tile
  private loadedTraffic: { [key: string]: TrafficLoop[] } = {};
  // building footprints per loaded tile, for click-picking
  private loadedBuildings: { [key: string]: BuildingInfo[] } = {};
  // fence/wall lines per loaded tile, for the car's collision
  private loadedBarriers: { [key: string]: BarrierInfo[] } = {};
  // water features per loaded tile, for click-picking
  private loadedWater: { [key: string]: WaterInfo[] } = {};
  // street-furniture points per loaded tile, for click-picking
  private loadedFurniture: { [key: string]: FurnitureInfo[] } = {};
  // fountains per loaded tile, for click-picking
  private loadedFountains: { [key: string]: FountainInfo[] } = {};
  // transit stops per loaded tile, for click-picking
  private loadedTransit: { [key: string]: TransitInfo[] } = {};
  // outdoor terraces per loaded tile, for click-picking
  private loadedTerraces: { [key: string]: TerraceInfo[] } = {};
  // playgrounds and monuments per loaded tile, for click-picking
  private loadedPlaygrounds: { [key: string]: PlaygroundInfo[] } = {};
  private loadedMonuments: { [key: string]: MonumentInfo[] } = {};
  // rail platforms per loaded tile, for click-picking
  private loadedPlatforms: { [key: string]: PlatformInfo[] } = {};
  // rooftop accessories per loaded tile, for click-picking
  private loadedRooftops: { [key: string]: RooftopInfo[] } = {};
  // construction sites per loaded tile, for click-picking
  private loadedConstruction: { [key: string]: ConstructionInfo[] } = {};
  // marked crossings per loaded tile, for click-picking
  private loadedCrosswalks: { [key: string]: CrosswalkInfo[] } = {};
  // runway centrelines per loaded tile, for the airplane layer
  private loadedRunways: { [key: string]: RunwayLine[] } = {};
  private loadedAprons: { [key: string]: ApronRing[] } = {};
  // signal/crossing points per loaded tile, for the traffic speed bump
  private loadedCrossings: { [key: string]: [number, number][] } = {};
  private loadedSignals: { [key: string]: [number, number][] } = {};
  private loadedLamps: { [key: string]: LampSpot[] } = {};
  // parked cars per loaded tile, for the static cars around the centre
  private loadedParking: { [key: string]: ParkedCar[] } = {};
  // the layer keeps one mesh per tile and diffs them itself
  private parkedCars?: ParkedCarLayer;
  private parkedCarsEnabled = true;
  private nightLights?: NightLights;
  private lamppostsEnabled = true;
  // bloom is a post pass over the 3D scene only, so this is a plain switch; it
  // is forced off on the software rasterizer in render()
  private bloomEnabled = true;
  private bloom?: BloomPass;
  // The scene's own draw stats, captured before the bloom passes overwrite
  // renderer.info (the final composite is a one-draw, two-triangle quad).
  private lastSceneDraw = { calls: 0, triangles: 0 };
  // render timestamps for the perf report; a two-second window is long enough
  // to smooth a hitch but short enough to follow a pan or a toggle
  private frameTimes: number[] = [];
  private fpsValue = 0;
  // facade detail (windows/doors and balconies) meshes per tile, built only
  // while zoomed in; kept out of loadedTiles so stats() and click-picking stay
  // as they were
  private loadedDetail: {
    [key: string]: { windows: THREE.Mesh | null; balconies: THREE.Mesh | null };
  } = {};
  // layer checkboxes
  private windowsEnabled = true;
  private balconiesEnabled = true;
  private roofShapesEnabled = true;
  // water is its own per-tile mesh, so this is a plain visibility switch
  private waterEnabled = true;
  // benches are their own per-tile mesh too
  private benchesEnabled = true;
  // the church cross is a per-tile mesh as well: the toggle hides the ornament,
  // the church walls stay buildings (its stony look is baked into them)
  private churchesEnabled = true;
  // parks and grass are their own per-tile mesh too: a plain visibility switch
  private parksEnabled = true;
  // tarmac is its own per-tile mesh too, and the planes a scene layer; the one
  // checkbox switches both
  private airplanesEnabled = true;
  // fences are their own per-tile mesh too, but only shown once zoomed in
  private fencesEnabled = true;
  // bridges and tunnels are their own per-tile meshes too, so this is a plain
  // visibility switch covering both kinds
  private bridgesEnabled = true;
  // transit stops, platforms and rails share one checkbox
  private transitEnabled = true;
  // sidewalk slabs are their own per-tile mesh
  private sidewalksEnabled = true;
  private wallsEnabled = true;
  private rooftopsEnabled = true;
  private parkPathsEnabled = true;
  private powerLinesEnabled = true;
  // when false, a color tilegen had to impute is ignored (needs a tile reload,
  // since the colors are baked into the geometry)
  private imputedColorsEnabled = true;
  private highlight?: THREE.Object3D;
  private popup?: Popup;
  private carsTraffic?: TrafficRenderer;
  private trainsTraffic?: TrafficRenderer;
  private busesTraffic?: TrafficRenderer;
  private tramsTraffic?: TrafficRenderer;
  // the moving bus/tram the camera is following; cleared by a map click or drag
  private following?: {
    renderer: TrafficRenderer;
    loopId: string;
    phase: number;
  };
  private lastFollowAt = 0;
  // car mode: the free-driving car, the keys currently held, and the map
  // handlers we disabled on entry so exiting can put them back exactly
  private driving?: DrivingCar;
  private drivingActive = false;
  private driveKeys = new Set<string>();
  private lastDriveFrame = 0;
  private lastDriveTilePass = 0;
  private lastDriveShadow = 0;
  private lastDriveHud = 0;
  private driveTileTimer: ReturnType<typeof setTimeout> | undefined;
  private driveInteractions?: {
    dragPan: boolean;
    dragRotate: boolean;
    scrollZoom: boolean;
    boxZoom: boolean;
    doubleClickZoom: boolean;
    touchZoomRotate: boolean;
    touchPitch: boolean;
    keyboard: boolean;
  };
  private driveButton?: HTMLButtonElement;
  private driveHud?: HTMLElement;
  private driveSpeed?: HTMLElement;
  private clouds?: CloudLayer;
  private airplanes?: PlaneLayer;
  // the scene lights, kept so the time-of-day model can drive them. They are
  // created in onAdd (with the renderer) and are undefined until then.
  private sunLight?: THREE.DirectionalLight;
  private fillLight?: THREE.DirectionalLight;
  private hemisphereLight?: THREE.HemisphereLight;
  private groundMesh?: THREE.Mesh;
  private shadowGround?: THREE.Mesh;
  // headless CI runs on SwiftShader; the shadow pass is not worth it there
  private softwareRenderer = false;
  // hours 0..24, local mean solar time at Milan; seeded from the real sun and
  // driven by the slider/night checkbox afterwards. The slider steps 0.25 h, so
  // round the seed to match rather than give the thumb a fractional value.
  private timeOfDay = Math.round(currentMilanSolarHour() * 4) / 4;
  private lighting: Lighting = lightingAt(this.timeOfDay);
  // which basemap is mounted, so a night/day flip only swaps the style once
  private darkBasemap = false;
  // the basemap checkbox; while off the map keeps an empty style and only the
  // 3D custom layer is drawn
  private basemapEnabled = true;
  // user toggle (the page checkbox); combined with the zoom gate
  private trafficEnabled = true;
  // whether clicking a building inspects it
  private inspectEnabled = true;
  // user toggle for the decorative cloud layer (also gated on the zoom)
  private cloudsEnabled = true;
  // tiles with a fetch in flight; kept separate from loadedTiles so a failed
  // load does not leave a permanent "loaded but empty" entry that blocks retries
  private pendingTiles: Set<string> = new Set();
  private renderTileMargin: number = 3;
  // move fires continuously; debounce the tile load/unload pass
  private moveDebounce: ReturnType<typeof setTimeout> | undefined;
  private shadowTimer: ReturnType<typeof setTimeout> | undefined;
  // increments every time the projection origin is reset, so in-flight
  // async tile loads from the old origin can be recognized and discarded
  private originGeneration: number = 0;
  private modelTransform: {
    translateX: number;
    translateY: number;
    translateZ: number;
    rotateX: number;
    rotateY: number;
    rotateZ: number;
    scale: number;
  };
  constructor(tileCenter: [number, number], zoomLevel: number = 16) {
    // A saved day/night switch wins over the solar seed, so the first basemap
    // is the one the user last chose instead of a frame of the other one.
    const savedNight = readCheckboxCookie()["night-toggle"];
    if (savedNight !== undefined) {
      this.timeOfDay = savedNight ? NIGHT_HOUR : DAY_HOUR;
      this.lighting = lightingAt(this.timeOfDay);
    }
    // Open on the basemap the current sun calls for, so the day style does not
    // flash before the first applyLighting() swaps it.
    const nightBasemap = this.lighting.night > BASEMAP_NIGHT_AT;
    this.darkBasemap = nightBasemap;
    this.map = new MapLibreMap({
      container: "central-map",
      center: tileCenter,
      zoom: zoomLevel,
      pitch: 30,
      // keep the view in the URL as OSM does ("#map=zoom/lat/lon"), so a
      // position can be linked; the prefix makes maplibre use that shape, and
      // it reads a fragment pasted on load and updates it as the map moves
      hash: "map",
      style: basemapStyleUrl(nightBasemap ? BASEMAP_NIGHT : BASEMAP_DAY),
    });
    // the projection origin follows whatever the map actually opened on (a
    // #map= fragment may have moved it), so no tiles are fetched for the
    // default center first
    const opened = this.map.getCenter();
    this.tileCenter = [opened.lng, opened.lat];
    // for debugging
    this.map.showTileBoundaries = false;

    this.map.addControl(
      new ScaleControl({
        maxWidth: 80,
        unit: "metric",
      }),
    );
    // MapLibre's own "use my location" button: it asks the browser for the
    // position and flies the map there. Not tracking, just a one-shot centering.
    this.map.addControl(
      new GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: false,
        showAccuracyCircle: true,
      }),
      "top-right",
    );
    // MapLibre's compass resets the bearing to north; the zoom buttons are
    // deliberately off because the map already has a scale bar and wheel zoom.
    this.map.addControl(
      new NavigationControl({
        showCompass: true,
        showZoom: false,
        visualizePitch: false,
      }),
      "top-right",
    );
    // parameters to ensure the model is georeferenced correctly on the map.
    // Use the center the map actually opened on (a #map= fragment may have
    // moved it): seeding this from the constructor argument shifted the whole
    // scene by kilometers whenever the hash stayed within the 2-tile
    // origin-reset margin, so the scene was never realigned.
    const modelOrigin = this.tileCenter;
    const modelAltitude = 0;
    const modelRotate = [0, 0, 0];

    const modelAsMercatorCoordinate = MercatorCoordinate.fromLngLat(
      modelOrigin,
      modelAltitude,
    );
    // console.log("MERCATOR: ", modelAsMercatorCoordinate, modelAsMercatorCoordinate.toLngLat())

    // transformation parameters to position, rotate and scale the 3D model onto the map
    this.modelTransform = {
      translateX: modelAsMercatorCoordinate.x,
      translateY: modelAsMercatorCoordinate.y,
      translateZ: modelAsMercatorCoordinate.z,
      rotateX: modelRotate[0],
      rotateY: modelRotate[1],
      rotateZ: modelRotate[2],
      /* Since our 3D model is in real world meters, a scale transform needs to be
       * applied since the CustomLayerInterface expects units in MercatorCoordinates.
       */
      // in this case is 3.5646655226473536e-8
      scale: modelAsMercatorCoordinate.meterInMercatorCoordinateUnits(),
    };
    // the render callback is invoked with the layer as `this`, so capture
    // the map instance to reach the (mutable) modelTransform
    const coolMap = this;
    // configuration of the custom layer for a 3D model per the CustomLayerInterface
    this.customLayer = {
      id: "3d-model",
      type: "custom",
      renderingMode: "3d",
      map: this.map,
      camera: new THREE.PerspectiveCamera(),
      scene: new THREE.Scene(),
      onAdd(map, gl) {
        // A style swap (the night basemap) can re-add this layer on the same
        // canvas and GL context. Rebuilding the renderer, the lights and the
        // scene layers would duplicate them, so only refresh the map reference
        // and leave the existing scene as it is.
        this.map = map;
        if (this.renderer) return;

        // headless CI renders on SwiftShader; skip the shadow pass there (it
        // roughly doubles the software rasterizer's frame time)
        const rendererInfo = gl.getExtension("WEBGL_debug_renderer_info");
        const rendererName = rendererInfo
          ? String(gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL))
          : "";
        coolMap.softwareRenderer =
          /swiftshader|llvmpipe|softpipe|software/i.test(rendererName);

        // atmospheric fog, matched to the sky color in applyLighting(); it
        // blends the far 3D edges into the horizon instead of cutting off
        this.scene.fog = new THREE.Fog(0xd9e3ea, 1200, 6000);

        // lighting: a warm sun, a cool fill from the opposite side, and a
        // hemisphere light so faces away from the sun are not pitch black.
        // Their colors and intensities are set from the time of day in
        // applyLighting(), so the starting values here do not matter much.
        const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
        sun.position.set(-40, 60, 100).normalize();
        // one tight shadow cascade around the view: 2 km across is enough at
        // city zooms and keeps the texel size usable at 2048
        sun.castShadow = !coolMap.softwareRenderer;
        sun.shadow.mapSize.set(2048, 2048);
        sun.shadow.camera.left = -1000;
        sun.shadow.camera.right = 1000;
        sun.shadow.camera.top = 1000;
        sun.shadow.camera.bottom = -1000;
        // the light sits 3 km out; a tight depth range keeps the 24-bit depth
        // precise enough to avoid acne on roofs and walls
        sun.shadow.camera.near = 1000;
        sun.shadow.camera.far = 5000;
        sun.shadow.bias = -0.0002;
        sun.shadow.normalBias = 2.0;
        this.scene.add(sun.target);
        this.scene.add(sun);
        coolMap.sunLight = sun;

        const fill = new THREE.DirectionalLight(0xbfd4ff, 0.6);
        fill.position.set(60, -50, 60).normalize();
        this.scene.add(fill);
        coolMap.fillLight = fill;

        const hemisphere = new THREE.HemisphereLight(0xcfe0ff, 0x4a4030, 1.0);
        this.scene.add(hemisphere);
        coolMap.hemisphereLight = hemisphere;

        // faint ground plane under everything (also a shadow catcher later)
        const ground = new THREE.Mesh(
          new THREE.PlaneGeometry(20000, 20000),
          new THREE.MeshBasicMaterial({
            color: 0x8a8f95,
            transparent: true,
            opacity: 0.12,
            depthWrite: false,
          }),
        );
        ground.position.z = -0.05;
        ground.renderOrder = -1;
        this.scene.add(ground);
        coolMap.groundMesh = ground;

        // a transparent catcher for the sun shadows: it darkens the basemap
        // and the ground under buildings, trees and cars without covering it
        const shadowGround = new THREE.Mesh(
          new THREE.PlaneGeometry(20000, 20000),
          new THREE.ShadowMaterial({ opacity: 0.32 }),
        );
        shadowGround.position.z = -0.04;
        shadowGround.receiveShadow = true;
        shadowGround.material.depthWrite = false;
        shadowGround.renderOrder = -0.5;
        shadowGround.frustumCulled = false;
        this.scene.add(shadowGround);
        coolMap.shadowGround = shadowGround;

        // this.scene.add(heartMesh());

        // // use the three.js GLTF loader to add the 3D model to the three.js scene
        // const loader = new GLTFLoader();
        // loader.load(
        //     'https://maplibre.org/maplibre-gl-js/docs/assets/34M_17/34M_17.gltf',
        //     (gltf) => {
        //         this.scene.add(gltf.scene);
        //     }
        // );
        this.map = map;

        // use the MapLibre GL JS map canvas for three.js
        this.renderer = new THREE.WebGLRenderer({
          canvas: map.getCanvas(),
          context: gl,
          antialias: true,
        });

        // filmic tone mapping for a less flat look
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;
        this.renderer.shadowMap.enabled = !coolMap.softwareRenderer;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        // one shadow render when the view/time changes, not every frame
        this.renderer.shadowMap.autoUpdate = false;

        this.renderer.autoClear = false;
        // night bloom: a post pass over the scene only, composited back over
        // MapLibre's basemap. Created here because it needs the renderer.
        coolMap.bloom = new BloomPass(this.renderer);
        // animated cars and trains, added to the scene directly — NOT via
        // loadedTiles — so the origin reset does not touch them; their
        // positions are recomputed each frame from the precomputed loops
        coolMap.carsTraffic = new TrafficRenderer(this.scene, CAR_TRAFFIC);
        coolMap.trainsTraffic = new TrafficRenderer(this.scene, TRAIN_TRAFFIC);
        coolMap.busesTraffic = new TrafficRenderer(this.scene, BUS_TRAFFIC);
        coolMap.tramsTraffic = new TrafficRenderer(this.scene, TRAM_TRAFFIC);
        // decorative clouds, also added directly to the scene: their positions
        // are relative to the visible area rather than to a tile
        coolMap.clouds = new CloudLayer(this.scene);
        coolMap.clouds.setEnabled(coolMap.cloudsEnabled);
        // decorative airliners, a scene layer like the clouds: they fly the
        // loaded runways and are a pure function of time
        coolMap.airplanes = new PlaneLayer(this.scene);
        coolMap.airplanes.setEnabled(coolMap.airplanesEnabled);
        // static parked cars: same body as the moving ones, around the centre
        coolMap.parkedCars = new ParkedCarLayer(this.scene);
        coolMap.parkedCars.setEnabled(coolMap.parkedCarsEnabled);
        // warm lamps and red/green signal heads for the night
        coolMap.nightLights = new NightLights(this.scene);
        // the lights now exist, so push the current time-of-day state onto them
        coolMap.applyLighting();
        // tiles may already have loaded before this layer was added, so seed
        // the renderer with whatever routes are present
        coolMap.syncTraffic();
        coolMap.syncTraffic();
        coolMap.syncAirplanes();
        coolMap.syncParkedCars();
        coolMap.syncNightLights();
        // NOTE: currently broken
        // see https://github.com/potree/potree/blob/develop/src/viewer/viewer.js#L1921
        // this.renderer.xr.enabled = true;
        // document.body.appendChild(VRButton.createButton(this.renderer));
      },
      render(gl, args) {
        coolMap.recordFrame(performance.now());
        const modelTransform = coolMap.modelTransform;
        const rotationX = new THREE.Matrix4().makeRotationAxis(
          new THREE.Vector3(1, 0, 0),
          modelTransform.rotateX,
        );
        const rotationY = new THREE.Matrix4().makeRotationAxis(
          new THREE.Vector3(0, 1, 0),
          modelTransform.rotateY,
        );
        const rotationZ = new THREE.Matrix4().makeRotationAxis(
          new THREE.Vector3(0, 0, 1),
          modelTransform.rotateZ,
        );

        const m = new THREE.Matrix4().fromArray(
          args.defaultProjectionData.mainMatrix,
        );
        const l = new THREE.Matrix4()
          .makeTranslation(
            modelTransform.translateX,
            modelTransform.translateY,
            modelTransform.translateZ,
          )
          .scale(
            new THREE.Vector3(
              modelTransform.scale,
              -modelTransform.scale,
              modelTransform.scale,
            ),
          )
          .multiply(rotationX)
          .multiply(rotationY)
          .multiply(rotationZ);

        // Alternatively, you can use this API to get the correct model matrix.
        // It will work regardless of current projection.
        // Also see the example "globe-3d-model.html".
        //
        // const modelMatrix = args.getMatrixForModel(modelOrigin, modelAltitude);
        // const m = new THREE.Matrix4().fromArray(matrix);
        // const l = new THREE.Matrix4().fromArray(modelMatrix);

        this.camera.projectionMatrix = m.multiply(l);
        // raycaster (for click-picking) needs the inverse to unproject NDC
        this.camera.projectionMatrixInverse
          .copy(this.camera.projectionMatrix)
          .invert();
        const originMeters = epsg4326toEpsg3857(coolMap.tileCenter);
        const scaleFactor = Math.cos(
          (2 * Math.PI * coolMap.tileCenter[1]) / 360,
        );
        // cull vehicles whose run is outside what the camera can see; the
        // renderer pads this window before dropping anything
        const bounds = coolMap.map.getBounds();
        const view = {
          west: bounds.getWest(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          north: bounds.getNorth(),
        };
        if (coolMap.carsTraffic) {
          coolMap.carsTraffic.update(originMeters, scaleFactor, view);
        }
        if (coolMap.trainsTraffic) {
          coolMap.trainsTraffic.update(originMeters, scaleFactor, view);
        }
        if (coolMap.busesTraffic) {
          coolMap.busesTraffic.update(originMeters, scaleFactor, view);
        }
        if (coolMap.tramsTraffic) {
          coolMap.tramsTraffic.update(originMeters, scaleFactor, view);
        }
        coolMap.updateFollow();
        coolMap.updateDriving(originMeters, scaleFactor);
        coolMap.updateClouds(originMeters, scaleFactor);
        // planes are placed from wall-clock time and the loaded runways
        coolMap.airplanes?.update(originMeters, scaleFactor, {
          zoom: coolMap.map.getZoom(),
          now: performance.now(),
        });
        // drive the water ripples from wall-clock time (the render loop runs
        // every frame via triggerRepaint)
        waterMaterial.uniforms.uTime.value = performance.now() / 1000;
        fountainWaterMaterial.uniforms.uTime.value = performance.now() / 1000;
        // MapLibre bakes the view into the projection, so recover the eye from
        // it each frame: the glitter path needs a view direction that follows
        // a pan or a tilt
        cameraCenter(
          this.camera.projectionMatrix,
          waterMaterial.uniforms.uCameraPosition.value as THREE.Vector3,
        );
        greenMaterial.uniforms.uTime.value = performance.now() / 1000;
        // the trees' canopy sway, patched into their Lambert material
        treeSway.value = performance.now() / 1000;
        coolMap.nightLights?.update(performance.now() / 1000);
        if (this.renderer) {
          this.renderer.resetState();
          // bloom only at night, where the lit windows and lamps are; by day it
          // would just soften the whole city and cost two extra passes
          let bloomed = false;
          if (
            coolMap.bloom &&
            coolMap.bloomEnabled &&
            !coolMap.softwareRenderer &&
            coolMap.lighting.night > BLOOM_NIGHT_AT
          ) {
            try {
              bloomed = coolMap.bloom.render(this.scene, this.camera);
            } catch (error) {
              // a failed pass must never cost us the frame: fall through to the
              // direct render, and try the pass again next frame
              console.warn(
                "bloom pass failed, falling back to direct render",
                error,
              );
              bloomed = false;
            }
          }
          if (!bloomed) {
            this.renderer.render(this.scene, this.camera);
            // renderer.info now describes the scene, before the bloom passes
            // (which render quads) overwrite it
            coolMap.lastSceneDraw.calls = this.renderer.info.render.calls;
            coolMap.lastSceneDraw.triangles =
              this.renderer.info.render.triangles;
          } else if (coolMap.bloom) {
            coolMap.lastSceneDraw.calls = coolMap.bloom.lastSceneInfo.calls;
            coolMap.lastSceneDraw.triangles =
              coolMap.bloom.lastSceneInfo.triangles;
          }
          // hand a clean context back to MapLibre: resetState unbinds our
          // targets and restores the default framebuffer
          this.renderer.resetState();
        } else {
          // this.renderer is set up on onAdd, so it should always be present
          // but typescript does not know that
          throw Error("render called when renderer is missing!!");
        }
        this.map.triggerRepaint();
      },
    };

    this.map.on("style.load", () => {
      // a style swap keeps the custom layer (only a full reload drops it), so
      // guard against adding it twice
      if (!this.map.getLayer(this.customLayer.id)) {
        this.map.addLayer(this.customLayer);
      }
      // load map data at setup before the user moves
      this.loadUnloadCoord(this.map.getCenter());
      this.applyTrafficState();
      // a style swap drops the sky; re-apply the current time-of-day state
      coolMap.applyLighting();
      // // this is only to show maplibre globe, not useful on a city-level map :)
      // this.map.setSky({ "atmosphere-blend": 1.0 });
      // this.map.setProjection({
      //   type: "globe", // Set projection to globe
      // });
    });

    this.map.on("move", () => {
      // bounds are to get the whole shown area
      // for now let's just get a fixed radius around the center
      // const bounds = this.map.getBounds();
      // console.log(bounds);
      // "move" fires on every pointer tick; wait until it settles before
      // running the (relatively expensive) load/unload pass
      if (this.moveDebounce !== undefined) {
        clearTimeout(this.moveDebounce);
      }
      this.moveDebounce = setTimeout(() => {
        this.moveDebounce = undefined;
        this.applyTrafficState();
        this.loadUnloadCoord(this.map.getCenter());
        this.syncBuildingDetail();
        this.refreshSunShadow();
      }, 150);
    });

    const trafficToggle = document.querySelector<HTMLInputElement>(
      "#traffic-toggle input",
    );
    if (trafficToggle) {
      this.trafficEnabled = trafficToggle.checked;
      trafficToggle.addEventListener("change", () =>
        this.setTrafficEnabled(trafficToggle.checked),
      );
    }

    const inspectToggle = document.querySelector<HTMLInputElement>(
      "#inspect-toggle input",
    );
    if (inspectToggle) {
      this.inspectEnabled = inspectToggle.checked;
      inspectToggle.addEventListener("change", () => {
        this.inspectEnabled = inspectToggle.checked;
        if (!this.inspectEnabled) this.clearSelection();
      });
    }

    const cloudsToggle = document.querySelector<HTMLInputElement>(
      "#clouds-toggle input",
    );
    if (cloudsToggle) {
      this.cloudsEnabled = cloudsToggle.checked;
      cloudsToggle.addEventListener("change", () =>
        this.setCloudsEnabled(cloudsToggle.checked),
      );
    }

    // day/night: the checkbox jumps between 13:00 (day) and 01:00 (night), the
    // slider picks any hour in between and can reach both
    const nightToggle = document.querySelector<HTMLInputElement>(
      "#night-toggle input",
    );
    const timeSlider = document.querySelector<HTMLInputElement>("#time-slider");
    const syncTimeControls = () => {
      if (nightToggle) {
        nightToggle.checked = this.lighting.night > BASEMAP_NIGHT_AT;
      }
      if (timeSlider) timeSlider.value = String(this.timeOfDay);
    };
    nightToggle?.addEventListener("change", () => {
      this.setTimeOfDay(nightToggle.checked ? NIGHT_HOUR : DAY_HOUR);
      syncTimeControls();
    });
    timeSlider?.addEventListener("input", () => {
      this.setTimeOfDay(Number(timeSlider.value));
      syncTimeControls();
    });
    syncTimeControls();

    // facade and roof detail toggles: the meshes are built per tile, so these
    // are plain visibility switches
    const wireToggle = (id: string, apply: (on: boolean) => void): void => {
      const input = document.querySelector<HTMLInputElement>(`${id} input`);
      if (!input) return;
      apply(input.checked);
      input.addEventListener("change", () => apply(input.checked));
    };
    wireToggle("#windows-toggle", (on) => {
      this.windowsEnabled = on;
      this.applyDetailVisibility();
    });
    wireToggle("#balconies-toggle", (on) => {
      this.balconiesEnabled = on;
      this.applyDetailVisibility();
    });
    wireToggle("#roof-shapes-toggle", (on) => {
      this.roofShapesEnabled = on;
      this.applyRoofVisibility();
    });
    wireToggle("#water-toggle", (on) => {
      this.waterEnabled = on;
      this.applyWaterVisibility();
    });
    wireToggle("#basemap-toggle", (on) => {
      this.setBasemapEnabled(on);
    });
    wireToggle("#sidewalks-toggle", (on) => {
      this.sidewalksEnabled = on;
      this.applySidewalkVisibility();
    });
    wireToggle("#walls-toggle", (on) => {
      this.wallsEnabled = on;
      this.applyWallVisibility();
    });
    wireToggle("#rooftop-toggle", (on) => {
      this.rooftopsEnabled = on;
      this.applyRooftopVisibility();
    });
    wireToggle("#power-lines-toggle", (on) => {
      this.powerLinesEnabled = on;
      this.applyPowerVisibility();
    });
    wireToggle("#park-paths-toggle", (on) => {
      this.parkPathsEnabled = on;
      this.applyParkPathVisibility();
    });
    wireToggle("#bloom-toggle", (on) => {
      this.bloomEnabled = on;
    });
    wireToggle("#benches-toggle", (on) => {
      this.benchesEnabled = on;
      this.applyBenchVisibility();
    });
    wireToggle("#churches-toggle", (on) => {
      this.churchesEnabled = on;
      this.applyChurchVisibility();
    });
    wireToggle("#parks-toggle", (on) => {
      this.parksEnabled = on;
      this.applyGreenVisibility();
    });
    wireToggle("#airplanes-toggle", (on) => {
      this.airplanesEnabled = on;
      this.applyAirplaneVisibility();
    });
    wireToggle("#fences-toggle", (on) => {
      this.fencesEnabled = on;
      this.applyFenceVisibility();
    });
    wireToggle("#parked-cars-toggle", (on) => {
      this.parkedCarsEnabled = on;
      this.applyParkedCarVisibility();
    });
    wireToggle("#lampposts-toggle", (on) => {
      this.lamppostsEnabled = on;
      this.applyNightLightsVisibility();
    });
    wireToggle("#bridges-toggle", (on) => {
      this.bridgesEnabled = on;
      this.applyBridgeVisibility();
    });
    wireToggle("#transit-toggle", (on) => {
      this.transitEnabled = on;
      this.applyTransitVisibility();
    });
    wireToggle("#imputed-colors-toggle", (on) => {
      if (on === this.imputedColorsEnabled) return;
      // the color is baked into the geometry, so the loaded tiles have to be
      // rebuilt: drop them and let the move pass fetch them again
      this.imputedColorsEnabled = on;
      this.reloadTiles();
    });

    // the gear opens the layer list; the chevron at the top of the list folds it
    const menuButton =
      document.querySelector<HTMLButtonElement>("#layer-menu-button");
    const menuPanel = document.querySelector<HTMLElement>("#layer-menu-panel");
    const menuCollapse = document.querySelector<HTMLButtonElement>(
      "#layer-menu-collapse",
    );
    const setMenuOpen = (open: boolean) => {
      if (!menuButton || !menuPanel) return;
      menuPanel.hidden = !open;
      menuButton.hidden = open;
      menuButton.setAttribute("aria-expanded", String(open));
    };
    menuButton?.addEventListener("click", () => setMenuOpen(true));
    menuCollapse?.addEventListener("click", () => setMenuOpen(false));

    // the question mark next to "imputed colors" explains what it means
    const helpButton =
      document.querySelector<HTMLButtonElement>("#imputed-help");
    const helpText = document.querySelector<HTMLElement>("#imputed-help-text");
    const setHelpOpen = (open: boolean) => {
      if (!helpText || !helpButton) return;
      helpText.hidden = !open;
      helpButton.setAttribute("aria-expanded", String(open));
    };
    helpButton?.addEventListener("click", () =>
      setHelpOpen(Boolean(helpText?.hidden)),
    );

    this.map.on("click", (event) => this.onMapClick(event));
    this.map.on("dragstart", () => this.stopFollowing());

    // car mode: the button toggles it, WASD drives, Escape leaves. The keys
    // only act while the mode is on, so typing in the page is unaffected.
    this.driveButton =
      document.querySelector<HTMLButtonElement>("#drive-button") ?? undefined;
    this.driveHud =
      document.querySelector<HTMLElement>("#drive-hud") ?? undefined;
    this.driveSpeed =
      document.querySelector<HTMLElement>("#drive-speed") ?? undefined;
    this.driveButton?.addEventListener("click", () => {
      if (this.drivingActive) this.stopDriving();
      else this.startDriving();
    });
    window.addEventListener("keydown", (event) => this.onDriveKeyDown(event));
    window.addEventListener("keyup", (event) => this.onDriveKeyUp(event));
    // a key held when the window loses focus would stay "down" forever
    window.addEventListener("blur", () => this.driveKeys.clear());
    this.applyDriveUi();

    document.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
        return;
      }
      saveCheckboxStates();
      this.reportPerf({ event: "toggle" });
    });
    const scheduleInitialReport = () => {
      if (!PERF_ENDPOINT) return;
      window.setTimeout(() => this.reportPerf(), 12000);
    };
    if (document.readyState === "complete") scheduleInitialReport();
    else window.addEventListener("load", scheduleInitialReport, { once: true });
  }

  // drop every loaded tile so the next load pass rebuilds them, picking up the
  // current load-time options (imputed colors)
  private reloadTiles() {
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        this.customLayer.scene.remove(mesh);
        if (mesh instanceof THREE.Mesh || mesh instanceof THREE.LineSegments) {
          mesh.geometry.dispose();
        }
      }
    }
    this.loadedTiles = {};
    this.loadedTraffic = {};
    this.loadedBuildings = {};
    this.loadedBarriers = {};
    this.loadedWater = {};
    this.loadedFurniture = {};
    this.loadedFountains = {};
    this.loadedTransit = {};
    this.loadedTerraces = {};
    this.loadedPlaygrounds = {};
    this.loadedMonuments = {};
    this.loadedPlatforms = {};
    this.loadedRooftops = {};
    this.loadedConstruction = {};
    this.loadedCrosswalks = {};
    this.loadedCrossings = {};
    this.loadedSignals = {};
    this.loadedLamps = {};
    this.loadedRunways = {};
    this.loadedAprons = {};
    this.loadedParking = {};
    this.parkedCars?.clear();
    this.clearBuildingDetail();
    this.syncTraffic();
    this.syncAirplanes();
    this.syncNightLights();
    this.refreshSunShadow();
    this.loadUnloadCoord(this.map.getCenter());
  }

  // click a building or a water body to highlight it and show its info
  private onMapClick(event: {
    point: { x: number; y: number };
    lngLat: LngLat;
  }) {
    // clicking the map is how the user stops following a vehicle, even when
    // inspect mode is off
    this.stopFollowing();
    // while driving, the map belongs to the car: clicks must not open popups or
    // yank the camera, and the drive button / Escape leaves the mode
    if (this.drivingActive) return;
    if (!this.inspectEnabled) return;
    const canvas = this.map.getCanvas();
    // event.point is already in CSS pixels relative to the map canvas
    const ndc = new THREE.Vector2(
      (event.point.x / canvas.clientWidth) * 2 - 1,
      -(event.point.y / canvas.clientHeight) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    // MapLibre bakes the view into the projection matrix, so build the ray
    // from two unprojected points instead of setFromCamera (which assumes the
    // camera sits at the world origin)
    const inv = this.customLayer.camera.projectionMatrixInverse;
    const near = new THREE.Vector3(ndc.x, ndc.y, -1).applyMatrix4(inv);
    const far = new THREE.Vector3(ndc.x, ndc.y, 1).applyMatrix4(inv);
    raycaster.set(near, far.sub(near).normalize());
    const pickable: THREE.Object3D[] = [];
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        const kind = mesh.userData.kind;
        // a hidden water layer is not pickable either
        if (
          kind === "building" ||
          kind === "glass" ||
          (kind === "water" && mesh.visible) ||
          kind === "furniture" ||
          kind === "fountain" ||
          kind === "fountain_water" ||
          kind === "playground" ||
          kind === "monument" ||
          kind === "construction" ||
          kind === "crosswalk" ||
          (kind === "custom_model" && mesh.visible) ||
          (kind === "rooftop" && mesh.visible) ||
          ((kind === "platform" ||
            kind === "transit_stop" ||
            kind === "metro_sign") &&
            mesh.visible) ||
          kind === "terrace"
        ) {
          pickable.push(mesh);
        }
      }
    }
    const hits = raycaster.intersectObjects(pickable, true);
    // a GTFS vehicle is in its own instanced mesh, so it is not in the static
    // pickable list; compare its ray distance with the nearest static hit
    const vehicle = this.vehicleAt(raycaster);
    if (hits.length === 0) {
      if (vehicle) this.selectVehicle(vehicle, event.lngLat);
      else this.clearSelection();
      return;
    }
    const hit = hits[0];
    if (vehicle && vehicle.distance < hit.distance) {
      this.selectVehicle(vehicle, event.lngLat);
      return;
    }
    const tileKey = (hit.object.userData.tileKey as string | undefined) ?? "";
    const point = hit.point;
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    if (hit.object.userData.kind === "custom_model") {
      const buildingId = hit.object.userData.buildingId as string | undefined;
      const info = (this.loadedBuildings[tileKey] ?? []).find(
        (candidate) => candidate.id === buildingId,
      );
      if (info) this.selectBuilding(info, event.lngLat);
      else this.clearSelection();
      return;
    }
    if (hit.object.userData.kind === "water") {
      const info = this.waterAt(tileKey, point, originMeters, scaleFactor);
      if (info) this.selectWater(info, event.lngLat);
      else this.clearSelection();
      return;
    }
    if (hit.object.userData.kind === "furniture") {
      const info = this.furnitureAt(tileKey, point, originMeters, scaleFactor);
      if (info) this.selectFurniture(info, event.lngLat);
      else this.clearSelection();
      return;
    }
    if (
      hit.object.userData.kind === "fountain" ||
      hit.object.userData.kind === "fountain_water"
    ) {
      const info = this.fountainAt(tileKey, point, originMeters, scaleFactor);
      if (info) this.selectFountain(info, event.lngLat);
      else this.clearSelection();
      return;
    }
    if (
      hit.object.userData.kind === "transit_stop" ||
      hit.object.userData.kind === "metro_sign"
    ) {
      const info = this.transitAt(tileKey, point, originMeters, scaleFactor);
      if (info) this.selectTransit(info, event.lngLat);
      else this.clearSelection();
      return;
    }
    if (hit.object.userData.kind === "terrace") {
      const info = this.terraceAt(tileKey, point, originMeters, scaleFactor);
      if (info) this.selectTerrace(info, event.lngLat);
      else this.clearSelection();
      return;
    }
    if (hit.object.userData.kind === "playground") {
      const info = this.playgroundAt(tileKey, point, originMeters, scaleFactor);
      if (info) this.selectPlayground(info, event.lngLat);
      else this.clearSelection();
      return;
    }
    if (hit.object.userData.kind === "monument") {
      const info = this.monumentAt(tileKey, point, originMeters, scaleFactor);
      if (info) this.selectMonument(info, event.lngLat);
      else this.clearSelection();
      return;
    }
    if (hit.object.userData.kind === "construction") {
      const info = this.constructionAt(
        tileKey,
        point,
        originMeters,
        scaleFactor,
      );
      if (info) this.selectConstruction(info, event.lngLat);
      else this.clearSelection();
      return;
    }
    if (hit.object.userData.kind === "crosswalk") {
      const info = this.crosswalkAt(tileKey, point, originMeters, scaleFactor);
      if (info) this.selectCrosswalk(info, event.lngLat);
      else this.clearSelection();
      return;
    }
    if (hit.object.userData.kind === "platform") {
      const info = this.platformAt(tileKey, point, originMeters, scaleFactor);
      if (info) this.selectPlatform(info, event.lngLat);
      else this.clearSelection();
      return;
    }
    if (hit.object.userData.kind === "rooftop") {
      const info = this.rooftopAt(tileKey, point, originMeters, scaleFactor);
      if (info) this.selectRooftop(info, event.lngLat);
      else this.clearSelection();
      return;
    }
    // A solar panel can sit under a pitched roof at the exact same spot, so
    // the roof wins the raycast even though the panel is what was clicked.
    // Give the mapped solar footprint precedence over the building below it.
    const solar = this.rooftopAt(tileKey, point, originMeters, scaleFactor);
    if (this.rooftopsEnabled && solar?.kind === "solar") {
      this.selectRooftop(solar, event.lngLat);
      return;
    }
    const candidates = this.loadedBuildings[tileKey] ?? [];
    let building = candidates.find((b) =>
      b.rings.some((ring) =>
        ringContains(ring, point, originMeters, scaleFactor),
      ),
    );
    if (!building) {
      // a roof/side hit can land just outside the footprint; take the nearest
      let best = 3;
      for (const candidate of candidates) {
        for (const ring of candidate.rings) {
          const distance = ringDistance(ring, point, originMeters, scaleFactor);
          if (distance < best) {
            best = distance;
            building = candidate;
          }
        }
      }
    }
    if (!building) {
      this.clearSelection();
      return;
    }
    this.selectBuilding(building, event.lngLat);
  }

  // the water feature under a hit point: an area whose ring contains it, else
  // the nearest waterway centreline within the ribbon's half width
  private waterAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): WaterInfo | undefined {
    const candidates = this.loadedWater[tileKey] ?? [];
    const inside = candidates.find((w) =>
      w.rings.some((ring) =>
        ringContains(ring, point, originMeters, scaleFactor),
      ),
    );
    if (inside) return inside;
    let best: WaterInfo | undefined;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
      const threshold = waterwayWidth(candidate.kind) * 0.5 + 1;
      for (const line of candidate.lines) {
        const distance = ringDistance(
          line,
          point,
          originMeters,
          scaleFactor,
          false,
        );
        if (distance <= threshold && distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
    }
    return best;
  }

  // the furniture point nearest a hit on the merged tile mesh
  private furnitureAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): FurnitureInfo | undefined {
    const candidates = this.loadedFurniture[tileKey] ?? [];
    let best: FurnitureInfo | undefined;
    let bestSq = 9;
    for (const info of candidates) {
      const m = toModelCoords([info.lon, info.lat], originMeters, scaleFactor);
      const dx = m[0] - point.x;
      const dy = m[1] - point.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestSq) {
        bestSq = distanceSq;
        best = info;
      }
    }
    return best;
  }

  private selectFurniture(info: FurnitureInfo, lngLat: LngLat) {
    this.clearSelection();
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    const [x, y] = toModelCoords(
      [info.lon, info.lat],
      originMeters,
      scaleFactor,
    );
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * Math.PI * 2;
      ring.push(
        new THREE.Vector3(
          x + Math.cos(angle) * 1.3,
          y + Math.sin(angle) * 1.3,
          0.12,
        ),
      );
    }
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(ring),
      new THREE.LineBasicMaterial({
        color: 0xffcc00,
        depthTest: false,
        transparent: true,
      }),
    );
    outline.renderOrder = 999;
    this.customLayer.scene.add(outline);
    this.highlight = outline;

    const label = FURNITURE_LABELS[info.kind] ?? info.kind.replace(/_/g, " ");
    const lines = [
      `<strong>${escapeHtml(label)}</strong>`,
      osmLink(info.id),
    ].filter(Boolean);
    if (lines.length === 0) return;
    this.popup = new Popup({ closeButton: true, offset: 8, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML(lines.join("<br>"))
      .addTo(this.map);
  }

  private fountainAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): FountainInfo | undefined {
    const candidates = this.loadedFountains[tileKey] ?? [];
    let best: FountainInfo | undefined;
    let bestSq = Infinity;
    for (const info of candidates) {
      const m = toModelCoords([info.lon, info.lat], originMeters, scaleFactor);
      const dx = m[0] - point.x;
      const dy = m[1] - point.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestSq) {
        bestSq = distanceSq;
        best = info;
      }
    }
    return best;
  }

  private selectFountain(info: FountainInfo, lngLat: LngLat) {
    this.clearSelection();
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    const [x, y] = toModelCoords(
      [info.lon, info.lat],
      originMeters,
      scaleFactor,
    );
    const radius = Math.max(1.5, info.size / 2 + 0.6);
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < 32; i++) {
      const angle = (i / 32) * Math.PI * 2;
      ring.push(
        new THREE.Vector3(
          x + Math.cos(angle) * radius,
          y + Math.sin(angle) * radius,
          0.15,
        ),
      );
    }
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(ring),
      new THREE.LineBasicMaterial({
        color: 0xffcc00,
        depthTest: false,
        transparent: true,
      }),
    );
    outline.renderOrder = 999;
    this.customLayer.scene.add(outline);
    this.highlight = outline;

    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      "Fountain",
      osmLink(info.id),
    ].filter(Boolean);
    this.popup = new Popup({ closeButton: true, offset: 8, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML(lines.join("<br>"))
      .addTo(this.map);
  }

  private transitAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): TransitInfo | undefined {
    const candidates = this.loadedTransit[tileKey] ?? [];
    let best: TransitInfo | undefined;
    let bestSq = 36;
    for (const info of candidates) {
      const m = toModelCoords([info.lon, info.lat], originMeters, scaleFactor);
      const dx = m[0] - point.x;
      const dy = m[1] - point.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestSq) {
        bestSq = distanceSq;
        best = info;
      }
    }
    return best;
  }

  private nearestPoint<T extends { lon: number; lat: number }>(
    candidates: T[],
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
    limit: number,
  ): T | undefined {
    let best: T | undefined;
    let bestSq = limit * limit;
    for (const info of candidates) {
      const m = toModelCoords([info.lon, info.lat], originMeters, scaleFactor);
      const dx = m[0] - point.x;
      const dy = m[1] - point.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestSq) {
        bestSq = distanceSq;
        best = info;
      }
    }
    return best;
  }

  private crosswalkAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): CrosswalkInfo | undefined {
    return this.nearestPoint(
      this.loadedCrosswalks[tileKey] ?? [],
      point,
      originMeters,
      scaleFactor,
      12,
    );
  }

  private selectCrosswalk(info: CrosswalkInfo, lngLat: LngLat) {
    this.clearSelection();
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    const [x, y] = toModelCoords(
      [info.lon, info.lat],
      originMeters,
      scaleFactor,
    );
    this.highlightPoint(x, y, 4);

    const label = info.crossing?.includes("traffic_signals")
      ? "Zebra crossing at traffic lights"
      : "Zebra crossing";
    this.popup = new Popup({ closeButton: true, offset: 8, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML([label, osmLink(info.id)].join("<br>"))
      .addTo(this.map);
  }

  private rooftopAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): RooftopInfo | undefined {
    const candidates = this.loadedRooftops[tileKey] ?? [];
    const inside = candidates.find((info) =>
      (info.rings ?? []).some((ring) =>
        ringContains(ring, point, originMeters, scaleFactor),
      ),
    );
    return (
      inside ??
      this.nearestPoint(candidates, point, originMeters, scaleFactor, 8)
    );
  }

  private selectRooftop(info: RooftopInfo, lngLat: LngLat) {
    this.clearSelection();
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    const [x, y] = toModelCoords(
      [info.lon, info.lat],
      originMeters,
      scaleFactor,
    );
    this.highlightPoint(x, y, 5);
    const labels: Record<string, string> = {
      water_tower: "Water tower",
      chimney: "Chimney",
      antenna: "Antenna",
      solar: "Solar panels",
    };
    const label = labels[info.kind] ?? "Rooftop equipment";
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      label,
      osmLink(info.id),
    ].filter(Boolean);
    this.popup = new Popup({ closeButton: true, offset: 8, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML(lines.join("<br>"))
      .addTo(this.map);
  }

  private platformAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): PlatformInfo | undefined {
    const candidates = this.loadedPlatforms[tileKey] ?? [];
    const inside = candidates.find((info) =>
      info.rings.some((ring) =>
        ringContains(ring, point, originMeters, scaleFactor),
      ),
    );
    return (
      inside ??
      this.nearestPoint(candidates, point, originMeters, scaleFactor, 6)
    );
  }

  private selectPlatform(info: PlatformInfo, lngLat: LngLat) {
    this.clearSelection();
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    const [x, y] = toModelCoords(
      [info.lon, info.lat],
      originMeters,
      scaleFactor,
    );
    this.highlightPoint(x, y, 6);
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      "Rail platform",
      osmLink(info.id),
    ].filter(Boolean);
    this.popup = new Popup({ closeButton: true, offset: 8, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML(lines.join("<br>"))
      .addTo(this.map);
  }

  private constructionAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): ConstructionInfo | undefined {
    const candidates = this.loadedConstruction[tileKey] ?? [];
    const inside = candidates.find((info) =>
      info.rings.some((ring) =>
        ringContains(ring, point, originMeters, scaleFactor),
      ),
    );
    if (inside) return inside;
    return this.nearestPoint(candidates, point, originMeters, scaleFactor, 30);
  }

  private selectConstruction(info: ConstructionInfo, lngLat: LngLat) {
    this.clearSelection();
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    const [x, y] = toModelCoords(
      [info.lon, info.lat],
      originMeters,
      scaleFactor,
    );
    this.highlightPoint(x, y, 8);

    const labels: Record<string, string> = {
      residential: "Residential construction",
      apartments: "Apartment construction",
      commercial: "Commercial construction",
      industrial: "Industrial construction",
      office: "Office construction",
      parking: "Parking construction",
      building: "Construction site",
    };
    const label = (info.kind && labels[info.kind]) ?? "Construction site";
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      label,
      osmLink(info.id),
    ].filter(Boolean);
    this.popup = new Popup({ closeButton: true, offset: 8, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML(lines.join("<br>"))
      .addTo(this.map);
  }

  private playgroundAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): PlaygroundInfo | undefined {
    return this.nearestPoint(
      this.loadedPlaygrounds[tileKey] ?? [],
      point,
      originMeters,
      scaleFactor,
      12,
    );
  }

  private monumentAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): MonumentInfo | undefined {
    return this.nearestPoint(
      this.loadedMonuments[tileKey] ?? [],
      point,
      originMeters,
      scaleFactor,
      5,
    );
  }

  private selectPlayground(info: PlaygroundInfo, lngLat: LngLat) {
    this.clearSelection();
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    const [x, y] = toModelCoords(
      [info.lon, info.lat],
      originMeters,
      scaleFactor,
    );
    this.highlightPoint(x, y, 7);
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      "Playground",
      osmLink(info.id),
    ].filter(Boolean);
    this.popup = new Popup({ closeButton: true, offset: 8, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML(lines.join("<br>"))
      .addTo(this.map);
  }

  private selectMonument(info: MonumentInfo, lngLat: LngLat) {
    this.clearSelection();
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    const [x, y] = toModelCoords(
      [info.lon, info.lat],
      originMeters,
      scaleFactor,
    );
    this.highlightPoint(x, y, 3);
    const labels: Record<string, string> = {
      statue: "Statue",
      bust: "Bust",
      plaque: "Plaque",
      stolperstein: "Stolperstein",
      war_memorial: "War memorial",
      sculpture: "Sculpture",
      stone: "Memorial stone",
      stele: "Stele",
      ghost_bike: "Ghost bike",
      obelisk: "Obelisk",
    };
    const label =
      (info.memorial && labels[info.memorial]) ??
      (info.kind === "monument" ? "Monument" : "Memorial");
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      label,
      osmLink(info.id),
    ].filter(Boolean);
    this.popup = new Popup({ closeButton: true, offset: 8, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML(lines.join("<br>"))
      .addTo(this.map);
  }

  private terraceAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): TerraceInfo | undefined {
    const candidates = this.loadedTerraces[tileKey] ?? [];
    let best: TerraceInfo | undefined;
    let bestSq = 25;
    for (const info of candidates) {
      const m = toModelCoords([info.lon, info.lat], originMeters, scaleFactor);
      const dx = m[0] - point.x;
      const dy = m[1] - point.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestSq) {
        bestSq = distanceSq;
        best = info;
      }
    }
    return best;
  }

  private selectTerrace(info: TerraceInfo, lngLat: LngLat) {
    this.clearSelection();
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    const [x, y] = toModelCoords(
      [info.lon, info.lat],
      originMeters,
      scaleFactor,
    );
    this.highlightPoint(x, y, 2.2);

    const labels: Record<string, string> = {
      cafe: "Cafe terrace",
      restaurant: "Restaurant terrace",
      bar: "Bar terrace",
      pub: "Pub terrace",
      fast_food: "Fast-food terrace",
      ice_cream: "Ice-cream terrace",
      biergarten: "Beer garden",
    };
    const label = labels[info.kind] ?? "Outdoor terrace";
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      label,
      osmLink(info.id),
    ].filter(Boolean);
    this.popup = new Popup({ closeButton: true, offset: 8, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML(lines.join("<br>"))
      .addTo(this.map);
  }

  private highlightPoint(x: number, y: number, radius: number): void {
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < 32; i++) {
      const angle = (i / 32) * Math.PI * 2;
      ring.push(
        new THREE.Vector3(
          x + Math.cos(angle) * radius,
          y + Math.sin(angle) * radius,
          0.12,
        ),
      );
    }
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(ring),
      new THREE.LineBasicMaterial({
        color: 0xffcc00,
        depthTest: false,
        transparent: true,
      }),
    );
    outline.renderOrder = 999;
    this.customLayer.scene.add(outline);
    this.highlight = outline;
  }

  private selectTransit(info: TransitInfo, lngLat: LngLat) {
    this.clearSelection();
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    const [x, y] = toModelCoords(
      [info.lon, info.lat],
      originMeters,
      scaleFactor,
    );
    this.highlightPoint(x, y, 2.6);

    const labels: Record<string, string> = {
      metro: "Metro entrance",
      bus: "Bus stop",
      tram: "Tram stop",
    };
    const label = labels[info.kind] ?? "Transit stop";
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      label,
      osmLink(info.id),
    ].filter(Boolean);
    this.popup = new Popup({ closeButton: true, offset: 8, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML(lines.join("<br>"))
      .addTo(this.map);
  }

  private selectWater(info: WaterInfo, lngLat: LngLat) {
    this.clearSelection();
    const label = info.kind
      ? info.kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
      : "Water";
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      escapeHtml(label),
      osmLink(info.id),
    ].filter(Boolean);
    if (lines.length === 0) return;
    this.popup = new Popup({ closeButton: true, offset: 8, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML(lines.join("<br>"))
      .addTo(this.map);
  }

  private vehicleAt(raycaster: THREE.Raycaster):
    | {
        meta: TrafficLoop["meta"];
        distance: number;
        renderer: TrafficRenderer;
        loopId: string;
        phase: number;
      }
    | undefined {
    let best:
      | {
          meta: TrafficLoop["meta"];
          distance: number;
          renderer: TrafficRenderer;
          loopId: string;
          phase: number;
        }
      | undefined;
    for (const fleet of [
      this.carsTraffic,
      this.busesTraffic,
      this.tramsTraffic,
    ]) {
      if (!fleet) continue;
      const hit = fleet.pick(raycaster);
      if (hit && (!best || hit.distance < best.distance)) {
        best = {
          meta: hit.meta,
          distance: hit.distance,
          renderer: fleet,
          loopId: hit.loopId,
          phase: hit.phase,
        };
      }
    }
    return best;
  }

  private selectVehicle(
    hit: {
      meta: TrafficLoop["meta"];
      renderer: TrafficRenderer;
      loopId: string;
      phase: number;
    },
    lngLat: LngLat,
  ) {
    this.clearSelection();
    const meta = hit.meta;
    const line = meta?.line?.trim();
    const route = meta?.route?.trim();
    const headsign = meta?.headsign?.trim();
    const mode = meta?.type === "tram" ? "Tram" : meta ? "Bus" : "Car";
    const title = line ? `${mode} ${line}` : mode;
    const description = [
      title,
      route && route !== line ? route : null,
      headsign ? `towards ${headsign}` : null,
    ]
      .filter(Boolean)
      .join(" — ");
    this.reportPerf({ event: "vehicle", vehicle: description });
    const lines = [
      `<strong>${escapeHtml(title)}</strong>`,
      route ? escapeHtml(route) : null,
      headsign ? `Towards ${escapeHtml(headsign)}` : null,
      '<span class="follow-hint">Following — click the map to stop</span>',
    ].filter(Boolean);
    this.popup = new Popup({ closeButton: true, offset: 8, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML(lines.join("<br>"))
      .addTo(this.map);
    this.popup.on("close", () => this.stopFollowing());
    this.startFollowing(hit.renderer, hit.loopId, hit.phase);
  }

  private startFollowing(
    renderer: TrafficRenderer,
    loopId: string,
    phase: number,
  ) {
    this.following = { renderer, loopId, phase };
    this.lastFollowAt = 0;
  }

  private stopFollowing() {
    this.following = undefined;
    this.lastFollowAt = 0;
  }

  private updateFollow() {
    if (!this.following) return;
    const { renderer, loopId, phase } = this.following;
    if (!renderer.enabled) {
      this.stopFollowing();
      return;
    }
    const position = renderer.positionAt(loopId, phase, renderer.currentTime);
    if (!position) return;
    const now = performance.now();
    if (now - this.lastFollowAt < 30) return;
    this.lastFollowAt = now;
    this.map.jumpTo({ center: [position.lon, position.lat] });
    this.popup?.setLngLat([position.lon, position.lat]);
  }

  // ---- car mode -----------------------------------------------------------
  // The car is a pure lon/lat state advanced every frame by updateDriving; the
  // camera chases it with jumpTo and the obstacle predicate comes from the
  // loaded tiles. There is no road graph: this is a free joyride over the 3D
  // city, not a driving simulation.

  // Start on the nearest precomputed car route when one is loaded. A map center
  // picked by the user can be inside a building, and a car under a roof is
  // invisible; a road point also gives the car a sensible starting heading.
  // Falls back to the map center when no route has loaded yet.
  private driveSpawn(): { lon: number; lat: number; heading: number } {
    const center = this.map.getCenter();
    const cosLat = Math.cos((center.lat * Math.PI) / 180);
    let best: { lon: number; lat: number; heading: number } | undefined;
    let bestDeg2 = Infinity;
    for (const loops of Object.values(this.loadedTraffic)) {
      for (const loop of loops) {
        if (loop.kind !== "car") continue;
        for (const run of loop.runs) {
          const coords = run.coords;
          for (let i = 1; i < coords.length; i++) {
            const [lon, lat] = coords[i];
            const dLon = (lon - center.lng) * cosLat;
            const dLat = lat - center.lat;
            const d2 = dLon * dLon + dLat * dLat;
            if (d2 >= bestDeg2) continue;
            const [prevLon, prevLat] = coords[i - 1];
            // a dwell keyframe repeats a coordinate; it has no heading
            if (prevLon === lon && prevLat === lat) continue;
            bestDeg2 = d2;
            best = {
              lon,
              lat,
              heading: Math.atan2(
                (lat - prevLat) * 110_540,
                (lon - prevLon) * cosLat * 111_320,
              ),
            };
          }
        }
      }
    }
    // within ~300 m: farther than that and the map center is more honest than
    // some road across the city
    if (best && bestDeg2 <= (300 / 111_320) ** 2) return best;
    return {
      lon: center.lng,
      lat: center.lat,
      heading: headingFromBearing(this.map.getBearing()),
    };
  }

  private startDriving() {
    if (this.drivingActive) return;
    this.stopFollowing();
    this.clearSelection();
    this.drivingActive = true;
    this.driveKeys.clear();
    if (!this.driving) this.driving = new DrivingCar(this.customLayer.scene);
    const spawn = this.driveSpawn();
    this.driving.start(spawn.lon, spawn.lat, spawn.heading);
    // the map's own gestures would fight a camera that jumps every frame
    this.driveInteractions = {
      dragPan: this.map.dragPan.isEnabled(),
      dragRotate: this.map.dragRotate.isEnabled(),
      scrollZoom: this.map.scrollZoom.isEnabled(),
      boxZoom: this.map.boxZoom.isEnabled(),
      doubleClickZoom: this.map.doubleClickZoom.isEnabled(),
      touchZoomRotate: this.map.touchZoomRotate.isEnabled(),
      touchPitch: this.map.touchPitch.isEnabled(),
      keyboard: this.map.keyboard.isEnabled(),
    };
    this.map.dragPan.disable();
    this.map.dragRotate.disable();
    this.map.scrollZoom.disable();
    this.map.boxZoom.disable();
    this.map.doubleClickZoom.disable();
    this.map.touchZoomRotate.disable();
    this.map.touchPitch.disable();
    this.map.keyboard.disable();
    const now = performance.now();
    this.lastDriveFrame = now;
    this.lastDriveTilePass = now;
    this.lastDriveShadow = now;
    this.lastDriveHud = 0;
    this.map.jumpTo({ zoom: DRIVE_ZOOM, pitch: DRIVE_PITCH });
    this.applyDriveUi();
    this.reportPerf({ event: "drive-start" });
  }

  private stopDriving() {
    if (!this.drivingActive) return;
    this.drivingActive = false;
    this.driveKeys.clear();
    this.lastDriveFrame = 0;
    this.driving?.stop();
    const interactions = this.driveInteractions;
    if (interactions) {
      if (interactions.dragPan) this.map.dragPan.enable();
      else this.map.dragPan.disable();
      if (interactions.dragRotate) this.map.dragRotate.enable();
      else this.map.dragRotate.disable();
      if (interactions.scrollZoom) this.map.scrollZoom.enable();
      else this.map.scrollZoom.disable();
      if (interactions.boxZoom) this.map.boxZoom.enable();
      else this.map.boxZoom.disable();
      if (interactions.doubleClickZoom) this.map.doubleClickZoom.enable();
      else this.map.doubleClickZoom.disable();
      if (interactions.touchZoomRotate) this.map.touchZoomRotate.enable();
      else this.map.touchZoomRotate.disable();
      if (interactions.touchPitch) this.map.touchPitch.enable();
      else this.map.touchPitch.disable();
      if (interactions.keyboard) this.map.keyboard.enable();
      else this.map.keyboard.disable();
      this.driveInteractions = undefined;
    }
    this.applyDriveUi();
    this.reportPerf({ event: "drive-stop" });
    // the map is the user's again: run one last tile pass around the car
    this.loadUnloadCoord(this.map.getCenter());
    this.syncBuildingDetail();
    this.refreshSunShadow();
  }

  private applyDriveUi() {
    if (this.driveButton) {
      this.driveButton.setAttribute("aria-pressed", String(this.drivingActive));
      const label = this.driveButton.querySelector("#drive-button-label");
      if (label)
        label.textContent = this.drivingActive ? "Exit drive" : "Drive";
    }
    if (this.driveHud) this.driveHud.hidden = !this.drivingActive;
  }

  private onDriveKeyDown(event: KeyboardEvent) {
    if (!this.drivingActive) return;
    const key = event.key.toLowerCase();
    if (key === "escape") {
      event.preventDefault();
      this.stopDriving();
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        /^(input|textarea|select)$/i.test(target.tagName))
    ) {
      return;
    }
    if (!DRIVE_KEY_SET.has(key)) return;
    // keep the arrows from scrolling the page and the map from panning
    event.preventDefault();
    this.driveKeys.add(key);
  }

  private onDriveKeyUp(event: KeyboardEvent) {
    this.driveKeys.delete(event.key.toLowerCase());
  }

  private driveInput(): DriveInput {
    const keys = this.driveKeys;
    return {
      forward: keys.has("w") || keys.has("arrowup"),
      backward: keys.has("s") || keys.has("arrowdown"),
      left: keys.has("a") || keys.has("arrowleft"),
      right: keys.has("d") || keys.has("arrowright"),
    };
  }

  // Advance the car and put the chase camera where the car is heading. Runs
  // from the render callback, so it shares the frame clock with everything
  // else. The tile window needs its own update: jumpTo fires "move" every
  // frame, which keeps the 150 ms debounce from ever settling.
  private updateDriving(originMeters: [number, number], scaleFactor: number) {
    if (!this.drivingActive || !this.driving) return;
    const now = performance.now();
    const dt = this.lastDriveFrame > 0 ? (now - this.lastDriveFrame) / 1000 : 0;
    this.lastDriveFrame = now;
    const state = this.driving.update(
      this.driveInput(),
      dt,
      originMeters,
      scaleFactor,
      (candidate) => this.driveBlocked(candidate),
    );
    const ahead = pointAhead(
      state.lon,
      state.lat,
      state.heading,
      DRIVE_LOOK_AHEAD,
    );
    this.map.jumpTo({
      center: ahead,
      bearing: headingToBearing(state.heading),
      pitch: DRIVE_PITCH,
      zoom: DRIVE_ZOOM,
    });
    // Run the tile pass after the render task, like the move debounce does, so
    // a projection origin reset lands between frames instead of mid-render.
    if (
      now - this.lastDriveTilePass >= DRIVE_TILE_PASS_MS &&
      this.driveTileTimer === undefined
    ) {
      this.lastDriveTilePass = now;
      this.driveTileTimer = setTimeout(() => {
        this.driveTileTimer = undefined;
        if (!this.drivingActive) return;
        this.loadUnloadCoord(this.map.getCenter());
        this.syncBuildingDetail();
        const at = performance.now();
        if (at - this.lastDriveShadow >= DRIVE_SHADOW_MS) {
          this.lastDriveShadow = at;
          this.refreshSunShadow();
        }
      }, 0);
    }
    if (now - this.lastDriveHud >= DRIVE_HUD_MS) {
      this.lastDriveHud = now;
      if (this.driveSpeed) {
        const kmh = Math.round(Math.abs(state.speed) * 3.6);
        this.driveSpeed.textContent =
          state.speed < -0.1 ? `R ${kmh} km/h` : `${kmh} km/h`;
      }
    }
  }

  // Whether the car's rectangle would overlap a building or a fence/wall at
  // `state`. The car only ever touches the tile it is in and the ring around
  // it, so those nine tiles are enough; each obstacle also has a precomputed
  // bbox, which rejects almost all of them before the edge tests.
  private driveBlocked(state: DriveState): boolean {
    const [cx, cy] = getTileIndex({ lng: state.lon, lat: state.lat });
    const rect = carRectangle(
      state.lon,
      state.lat,
      state.heading,
      CAR_TRAFFIC.length,
      CAR_TRAFFIC.width,
      DRIVE_CAR_MARGIN,
    );
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        const key = `${x}_${y}`;
        for (const building of this.loadedBuildings[key] ?? []) {
          if (!building.bbox || !boxesOverlap(rect.box, building.bbox)) {
            continue;
          }
          // a high building part floats over the street; the car drives under
          if ((building.base ?? 0) > DRIVE_CLEARANCE) continue;
          if (building.rings.some((ring) => ringIntersectsRect(ring, rect))) {
            return true;
          }
        }
        for (const barrier of this.loadedBarriers[key] ?? []) {
          // a hidden barrier must not block: the layer checkbox is the truth
          if (barrier.kind === "fence" && !this.fencesEnabled) continue;
          if (barrier.kind === "wall" && !this.wallsEnabled) continue;
          if (!boxesOverlap(rect.box, barrier.bbox)) continue;
          if (lineIntersectsRect(barrier.coords, rect)) return true;
        }
      }
    }
    return false;
  }

  // read-only collision probe for the e2e test: whether a car at this position
  // and heading would hit a building or a visible barrier
  collisionAt(lon: number, lat: number, heading = 0): boolean {
    return this.driveBlocked({ lon, lat, heading, speed: 0 });
  }

  // read-only state for the e2e test (like lightingState() and stats())
  driveState(): {
    active: boolean;
    lon: number;
    lat: number;
    heading: number;
    speed: number;
  } {
    const state = this.driving?.current;
    const center = this.map.getCenter();
    return {
      active: this.drivingActive,
      lon: state?.lon ?? center.lng,
      lat: state?.lat ?? center.lat,
      heading: state?.heading ?? 0,
      speed: state?.speed ?? 0,
    };
  }

  private selectBuilding(info: BuildingInfo, lngLat: LngLat) {
    this.clearSelection();
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);

    // outline: base + top loops and verticals for each ring
    const positions: number[] = [];
    for (const ring of info.rings) {
      const pts = ring.map((c) => toModelCoords(c, originMeters, scaleFactor));
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        positions.push(a[0], a[1], 0.3, b[0], b[1], 0.3);
        positions.push(a[0], a[1], info.height, b[0], b[1], info.height);
        positions.push(a[0], a[1], 0.3, a[0], a[1], info.height);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    const outline = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color: 0xffcc00,
        depthTest: false,
        transparent: true,
      }),
    );
    outline.renderOrder = 999;
    this.customLayer.scene.add(outline);
    this.highlight = outline;

    const address = [info.housenumber, info.street].filter(Boolean).join(" ");
    const imputed = new Set(info.imputed);
    const mark = (field: string) =>
      imputed.has(field) ? ' <span class="imputed">imputed</span>' : "";
    const swatch = (color: string | undefined) =>
      color
        ? `<span class="swatch" style="background:${escapeHtml(color)}"></span>`
        : "";
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      address ? escapeHtml(address) : null,
      `Height: ${info.height.toFixed(1)} m`,
      info.color
        ? `Wall: ${swatch(info.color)}${escapeHtml(info.color)}${mark("color")}`
        : null,
      info.roofShape
        ? `Roof: ${escapeHtml(info.roofShape)}${mark("roof_shape")}`
        : null,
      info.roofColor
        ? `Roof color: ${swatch(info.roofColor)}${escapeHtml(info.roofColor)}${mark("roof_color")}`
        : null,
      osmLink(info.id),
      `<a href="#" data-gltf class="gltf-link" title="Download GLTF">G</a>`,
      `<a href="#" data-zoom>Zoom to building</a>`,
    ].filter(Boolean);
    this.popup = new Popup({ closeButton: true, offset: 8, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML(lines.join("<br>"))
      .addTo(this.map);
    const link = this.popup
      .getElement()
      ?.querySelector("[data-zoom]") as HTMLElement | null;
    link?.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      this.zoomToBuilding(info);
    });
    const gltfLink = this.popup
      .getElement()
      ?.querySelector("[data-gltf]") as HTMLElement | null;
    gltfLink?.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      void this.downloadBuildingGLTF(info);
    });
  }

  private saveBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private async downloadBuildingGLTF(info: BuildingInfo) {
    const safe =
      (info.id ?? info.name ?? "building").replace(/[^a-z0-9._-]+/gi, "_") ||
      "building";
    if (info.model?.asset) {
      try {
        const response = await fetch(`tiles/${info.model.asset}`);
        if (!response.ok) throw new Error(`asset HTTP ${response.status}`);
        this.saveBlob(await response.blob(), `${safe}.glb`);
      } catch (error) {
        console.warn("building model download failed", error);
      }
      return;
    }
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    const feature: Geojson.Feature = {
      type: "Feature",
      id: info.id,
      properties: {
        color: info.color,
        height: info.height,
        base: info.base,
        roof_shape: info.roofShape,
        roof_color: info.roofColor,
        solar: info.solar,
        building: info.building,
        religion: info.religion,
        glass: info.glass,
      },
      geometry: info.geometry ?? {
        type: "Polygon",
        coordinates: info.rings,
      },
    };
    const parts = building(originMeters, scaleFactor, feature);
    const group = new THREE.Group();
    group.name = info.name ?? info.id ?? "building";
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0,
    });
    for (const part of parts) {
      group.add(new THREE.Mesh(part.walls, material));
      if (part.roof) group.add(new THREE.Mesh(part.roof, material));
    }
    try {
      const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        new GLTFExporter().parse(
          group,
          (result) => {
            if (result instanceof ArrayBuffer) resolve(result);
            else reject(new Error("GLTF exporter returned JSON, not binary"));
          },
          reject,
          { binary: true },
        );
      });
      this.saveBlob(
        new Blob([buffer], { type: "model/gltf-binary" }),
        `${safe}.glb`,
      );
    } catch (error) {
      console.warn("building GLTF export failed", error);
    }
  }

  private zoomToBuilding(info: BuildingInfo) {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const ring of info.rings) {
      for (const [lon, lat] of ring) {
        minLon = Math.min(minLon, lon);
        minLat = Math.min(minLat, lat);
        maxLon = Math.max(maxLon, lon);
        maxLat = Math.max(maxLat, lat);
      }
    }
    this.map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      { maxZoom: 19, duration: 700, padding: 60 },
    );
  }

  private clearSelection() {
    if (this.highlight) {
      this.customLayer.scene.remove(this.highlight);
      // the outline's geometry and material are created per selection
      if (
        this.highlight instanceof THREE.LineSegments ||
        this.highlight instanceof THREE.LineLoop
      ) {
        this.highlight.geometry.dispose();
        this.highlight.material.dispose();
      }
      this.highlight = undefined;
    }
    if (this.popup) {
      this.popup.remove();
      this.popup = undefined;
    }
  }

  private resetOrigin(center: LngLat) {
    const origin = MercatorCoordinate.fromLngLat(center, 0);
    const newScale = origin.meterInMercatorCoordinateUnits();
    const old = this.modelTransform;
    // A model point p is rendered at world = translate + scale * p (with the
    // y axis negated). To move to a new origin without dropping and
    // refetching every tile (which blanks the scene, i.e. flicker), re-express
    // each loaded mesh in the new origin's space: p' = a * p + b with
    // a = old.scale / newScale so the world position is preserved exactly.
    const a = old.scale / newScale;
    const remap = new THREE.Matrix4()
      .makeTranslation(
        (old.translateX - origin.x) / newScale,
        (origin.y - old.translateY) / newScale,
        0,
      )
      .multiply(new THREE.Matrix4().makeScale(a, a, a));
    Object.values(this.loadedTiles)
      .flat()
      .forEach((m) => m.applyMatrix4(remap));

    this.modelTransform = {
      translateX: origin.x,
      translateY: origin.y,
      translateZ: origin.z,
      rotateX: 0,
      rotateY: 0,
      rotateZ: 0,
      scale: newScale,
    };
    this.tileCenter = [center.lng, center.lat];
    // the highlight is in the old origin's model space; drop it
    this.clearSelection();
    // the facade detail is baked in the old origin's space too; drop it and let
    // the next sync rebuild it against the new origin
    this.clearBuildingDetail();
    // in-flight loads were baked against the old origin, so discard them and
    // clear their bookkeeping to let the load loop request them again
    this.originGeneration += 1;
    this.pendingTiles.clear();
    this.syncParkedCars();
    this.syncNightLights();
    this.refreshSunShadow();
    console.log("reset projection origin to", center.lng, center.lat);
  }

  private async loadUnloadCoord(center: LngLat) {
    // the farther the projection origin is from the visible area, the more
    // meters get squeezed into a Mercator unit (and the worse the float
    // precision), so when we drift too far from the tile of the current
    // origin, rebuild the transform around the current center
    // modelTransform.translateX/Y are Mercator world units, not lng/lat, so
    // build the coordinate directly and convert back with toLngLat()
    const [ox, oy] = getTileIndex(
      new MercatorCoordinate(
        this.modelTransform.translateX,
        this.modelTransform.translateY,
      ).toLngLat(),
    );
    const [cx, cy] = getTileIndex(center);
    if (Math.abs(ox - cx) > 2 || Math.abs(oy - cy) > 2) {
      this.resetOrigin(center);
    }
    let deleteUsKeys: string[] = [];
    Object.keys(this.loadedTiles).forEach((k) => {
      let x = Number(k.split("_")[0]);
      let y = Number(k.split("_")[1]);
      if (
        Math.abs(x - cx) > this.renderTileMargin ||
        Math.abs(y - cy) > this.renderTileMargin
      ) {
        console.log("Unloading tile ", k);
        // TODO why is forEach needed and the array breaks it??
        this.loadedTiles[k].forEach((m) => {
          this.customLayer.scene.remove(m);
          // each tile owns its merged geometry; the materials are shared
          // module-level singletons, so dispose only the geometry
          if (m instanceof THREE.Mesh || m instanceof THREE.LineSegments) {
            m.geometry.dispose();
          }
        });
        delete this.loadedTraffic[k];
        delete this.loadedBuildings[k];
        delete this.loadedBarriers[k];
        delete this.loadedWater[k];
        delete this.loadedFurniture[k];
        delete this.loadedFountains[k];
        delete this.loadedTransit[k];
        delete this.loadedTerraces[k];
        delete this.loadedPlaygrounds[k];
        delete this.loadedMonuments[k];
        delete this.loadedPlatforms[k];
        delete this.loadedRooftops[k];
        delete this.loadedConstruction[k];
        delete this.loadedCrosswalks[k];
        delete this.loadedCrossings[k];
        delete this.loadedSignals[k];
        delete this.loadedLamps[k];
        delete this.loadedRunways[k];
        delete this.loadedAprons[k];
        delete this.loadedParking[k];
        this.disposeDetail(k);
        deleteUsKeys.push(k);
      }
    });
    deleteUsKeys.forEach((k) => delete this.loadedTiles[k]);
    // the routes of an unloaded tile are gone; hand the renderer the remaining
    // ones. setLoops only reprepares plain data, so this is cheap enough to run
    // on the moves that actually unload a tile.
    if (deleteUsKeys.length > 0) {
      this.syncTraffic();
      this.syncAirplanes();
      this.syncParkedCars();
      this.syncNightLights();
      this.refreshSunShadow();
    }
    const generation = this.originGeneration;
    // inclusive bounds so the loaded window matches the retention window
    // above (|x - cx| <= margin), otherwise the +margin row/column is kept
    // loaded but never (re)fetched
    for (
      let x = cx - this.renderTileMargin;
      x <= cx + this.renderTileMargin;
      x++
    ) {
      for (
        let y = cy - this.renderTileMargin;
        y <= cy + this.renderTileMargin;
        y++
      ) {
        this.loadTile(x, y, generation);
      }
    }
  }

  private async loadTile(x: number, y: number, generation: number) {
    const tileKey = `${x}_${y}`;
    if (tileKey in this.loadedTiles || this.pendingTiles.has(tileKey)) {
      return;
    }
    this.pendingTiles.add(tileKey);
    try {
      const {
        meshes,
        buildings,
        barriers,
        water,
        furniture,
        fountains,
        transit,
        terraces,
        playgrounds,
        monuments,
        platforms,
        rooftops,
        construction,
        crosswalks,
        traffic,
        crossings,
        signals,
        runways,
        aprons,
        parking,
        lamps,
      } = await objectsAt(this.tileCenter, x, y, this.imputedColorsEnabled);
      if (generation !== this.originGeneration) {
        // the origin was reset while this tile was being computed, so the
        // meshes are in coordinates of a projection that is no longer used
        console.log("discarding stale tile", tileKey);
        return;
      }
      // the tile may have left the render window while it was loading; if so
      // don't add it (the move handler will skip it, or has already dropped it)
      const [cx, cy] = getTileIndex(this.map.getCenter());
      if (
        Math.abs(x - cx) > this.renderTileMargin ||
        Math.abs(y - cy) > this.renderTileMargin
      ) {
        return;
      }
      this.loadedTiles[tileKey] = meshes;
      meshes.forEach((m) => this.customLayer.scene.add(m));
      this.loadedTraffic[tileKey] = traffic;
      this.loadedBuildings[tileKey] = buildings;
      this.loadedBarriers[tileKey] = barriers;
      this.loadedWater[tileKey] = water;
      this.loadedFurniture[tileKey] = furniture;
      this.loadedFountains[tileKey] = fountains;
      this.loadedTransit[tileKey] = transit;
      this.loadedTerraces[tileKey] = terraces;
      this.loadedPlaygrounds[tileKey] = playgrounds;
      this.loadedMonuments[tileKey] = monuments;
      this.loadedPlatforms[tileKey] = platforms;
      this.loadedRooftops[tileKey] = rooftops;
      this.loadedConstruction[tileKey] = construction;
      this.loadedCrosswalks[tileKey] = crosswalks;
      this.loadedCrossings[tileKey] = crossings;
      this.loadedSignals[tileKey] = signals;
      this.loadedLamps[tileKey] = lamps;
      this.loadedRunways[tileKey] = runways;
      this.loadedAprons[tileKey] = aprons;
      this.loadedParking[tileKey] = parking;
      this.syncTraffic();
      this.syncAirplanes();
      this.syncBuildingDetail();
      this.applyPowerVisibility();
      this.applyParkPathVisibility();
      this.refreshSunShadow();
    } catch (e) {
      // leave the tile out of loadedTiles so a later move retries it
      console.warn("failed to load tile", tileKey, e);
    } finally {
      this.pendingTiles.delete(tileKey);
    }
  }

  // show/hide the traffic renderers from the toggle and the current zoom
  private applyTrafficState() {
    if (!this.carsTraffic || !this.trainsTraffic) return;
    const fleets = [
      this.carsTraffic,
      this.trainsTraffic,
      this.busesTraffic,
      this.tramsTraffic,
    ].filter((fleet): fleet is TrafficRenderer => fleet !== undefined);
    const on = this.trafficEnabled && this.map.getZoom() >= VEHICLE_MIN_ZOOM;
    if (on === this.carsTraffic.enabled) return;
    for (const fleet of fleets) fleet.setEnabled(on);
    if (on) this.syncTraffic();
  }

  // build the window/door meshes for the tiles around the centre, and drop the
  // rest. Called on the debounced move, on tile load/unload and after an origin
  // reset, so it is cheap when nothing changed (it only checks keys).
  private syncBuildingDetail() {
    this.syncParkedCars();
    this.syncNightLights();
    // roofs and water follow their checkboxes whatever the zoom
    this.applyTileVisibility();
    if (this.map.getZoom() < FACADE_MIN_ZOOM) {
      this.clearBuildingDetail();
      return;
    }
    const [cx, cy] = getTileIndex(this.map.getCenter());
    const keep = new Set<string>();
    for (let x = cx - FACADE_TILE_MARGIN; x <= cx + FACADE_TILE_MARGIN; x++) {
      for (let y = cy - FACADE_TILE_MARGIN; y <= cy + FACADE_TILE_MARGIN; y++) {
        const key = `${x}_${y}`;
        keep.add(key);
        if (this.loadedDetail[key]) continue;
        const infos = this.loadedBuildings[key];
        // not loaded yet: loadTile runs this again when it arrives
        if (!infos) continue;
        const originMeters = epsg4326toEpsg3857(this.tileCenter);
        const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
        const detail = tileFacadeDetail(originMeters, scaleFactor, infos);
        this.loadedDetail[key] = {
          windows: this.addDetailMesh(key, "windows", detail.windows),
          balconies: this.addDetailMesh(key, "balconies", detail.balconies),
        };
      }
    }
    for (const key of Object.keys(this.loadedDetail)) {
      if (!keep.has(key)) this.disposeDetail(key);
    }
    this.applyDetailVisibility();
    this.applyTileVisibility();
  }

  private addDetailMesh(
    tileKey: string,
    group: "windows" | "balconies",
    geometry: THREE.BufferGeometry | null,
  ): THREE.Mesh | null {
    if (!geometry) return null;
    // the windows light up at night, so they get their own shader material; the
    // balconies keep the shared lambert one
    const mesh = new THREE.Mesh(
      geometry,
      group === "windows" ? windowMaterial : facadeMaterial,
    );
    mesh.userData = { kind: "facade", group, tileKey };
    // thin quads lying on the walls: let the walls cast, not these
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.customLayer.scene.add(mesh);
    return mesh;
  }

  // the windows and the balconies follow their checkboxes; the zoom gate is
  // handled by building or dropping the meshes in syncBuildingDetail
  private applyDetailVisibility() {
    for (const { windows, balconies } of Object.values(this.loadedDetail)) {
      if (windows) windows.visible = this.windowsEnabled;
      if (balconies) balconies.visible = this.balconiesEnabled;
    }
  }

  // roofs are their own mesh per tile, so this is just visibility too
  private applyRoofVisibility() {
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        if (mesh.userData.kind === "roof") {
          mesh.visible = this.roofShapesEnabled;
        }
      }
    }
  }

  // water is a per-tile mesh as well, so its checkbox is a visibility switch
  private applyWaterVisibility() {
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        if (mesh.userData.kind === "water") {
          mesh.visible = this.waterEnabled;
        }
      }
    }
  }

  // benches are a per-tile mesh too
  private applyBenchVisibility() {
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        if (mesh.userData.kind === "bench") {
          mesh.visible = this.benchesEnabled;
        }
      }
    }
  }

  // bridges and tunnels are per-tile meshes too: one checkbox (bridges and
  // tunnels) drives both kinds
  private applyRooftopVisibility() {
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        if (mesh.userData.kind === "rooftop") {
          mesh.visible = this.rooftopsEnabled;
        }
      }
    }
  }

  private applyParkPathVisibility() {
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        if (mesh.userData.kind === "park_path") {
          mesh.visible = this.parkPathsEnabled;
        }
      }
    }
  }

  private applyPowerVisibility() {
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        const kind = mesh.userData.kind;
        if (kind === "power_tower" || kind === "power_wire") {
          mesh.visible = this.powerLinesEnabled;
        }
      }
    }
  }

  private applyWallVisibility() {
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        if (mesh.userData.kind === "wall" || mesh.userData.kind === "gate") {
          mesh.visible = this.wallsEnabled;
        }
      }
    }
  }

  private applySidewalkVisibility() {
    const on = this.sidewalksEnabled && this.map.getZoom() >= SIDEWALK_MIN_ZOOM;
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        if (mesh.userData.kind === "sidewalk") mesh.visible = on;
      }
    }
  }

  private applyTransitVisibility() {
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        const kind = mesh.userData.kind;
        if (
          kind === "transit_stop" ||
          kind === "metro_sign" ||
          kind === "platform" ||
          kind === "rail"
        ) {
          mesh.visible = this.transitEnabled;
        }
      }
    }
  }

  private applyBridgeVisibility() {
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        const kind = mesh.userData.kind;
        if (kind === "bridge" || kind === "tunnel") {
          mesh.visible = this.bridgesEnabled;
        }
      }
    }
  }

  // fences are a per-tile mesh too, gated on the zoom: the geometry is in the
  // tile either way (it is cheap), only the drawing waits for the zoom
  private applyFenceVisibility() {
    const on = this.fencesEnabled && this.map.getZoom() >= FENCE_MIN_ZOOM;
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        if (mesh.userData.kind === "fence") {
          mesh.visible = on;
        }
      }
    }
  }

  // ... and so is the church ornament: only the crosses go away, the walls are
  // plain buildings
  private applyChurchVisibility() {
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        if (mesh.userData.kind === "church") {
          mesh.visible = this.churchesEnabled;
        }
      }
    }
  }

  // ... and so is the green layer
  private applyGreenVisibility() {
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        if (mesh.userData.kind === "green") {
          mesh.visible = this.parksEnabled;
        }
      }
    }
  }

  // the airplane checkbox switches both the tarmac meshes and the plane layer
  private applyAirplaneVisibility() {
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        if (mesh.userData.kind === "aeroway") {
          mesh.visible = this.airplanesEnabled;
        }
      }
    }
    this.airplanes?.setEnabled(this.airplanesEnabled);
  }

  // the per-tile layers whose checkbox is just a visibility switch
  private applyTileVisibility() {
    this.applyRoofVisibility();
    this.applyWaterVisibility();
    this.applyBenchVisibility();
    this.applyChurchVisibility();
    this.applyGreenVisibility();
    this.applyAirplaneVisibility();
    this.applyFenceVisibility();
    this.applyBridgeVisibility();
    this.applyTransitVisibility();
    this.applySidewalkVisibility();
    this.applyWallVisibility();
    this.applyRooftopVisibility();
  }

  private disposeDetail(key: string) {
    const detail = this.loadedDetail[key];
    if (!detail) return;
    for (const mesh of [detail.windows, detail.balconies]) {
      if (!mesh) continue;
      this.customLayer.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    delete this.loadedDetail[key];
  }

  private clearBuildingDetail() {
    for (const key of Object.keys(this.loadedDetail)) this.disposeDetail(key);
  }

  setTrafficEnabled(enabled: boolean) {
    this.trafficEnabled = enabled;
    this.applyTrafficState();
  }

  setCloudsEnabled(enabled: boolean) {
    this.cloudsEnabled = enabled;
    // the layer may not exist yet (it is created when the style loads); onAdd
    // seeds it from this flag
    this.clouds?.setEnabled(enabled);
  }

  // the checkbox and the slider both funnel through here; cheap to recompute
  private setTimeOfDay(hour: number) {
    this.timeOfDay = hour;
    this.applyLighting();
  }

  // Push the time-of-day model onto the scene: the three lights, the renderer
  // exposure, the window shader, the clouds and the basemap. Called when the
  // time changes and once from onAdd, not every frame.
  private applyLighting() {
    const lighting = lightingAt(this.timeOfDay);
    this.lighting = lighting;
    if (this.sunLight) {
      this.sunLight.color.setHex(lighting.keyColor);
      this.sunLight.intensity = lighting.keyIntensity;
      this.sunLight.position.set(...lighting.keyDirection).normalize();
    }
    if (this.fillLight) {
      this.fillLight.color.setHex(lighting.fillColor);
      this.fillLight.intensity = lighting.fillIntensity;
    }
    if (this.hemisphereLight) {
      this.hemisphereLight.color.setHex(lighting.skyColor);
      this.hemisphereLight.groundColor.setHex(lighting.groundColor);
      this.hemisphereLight.intensity = lighting.hemisphereIntensity;
    }
    if (this.groundMesh) {
      (this.groundMesh.material as THREE.MeshBasicMaterial).color.setHex(
        lerpColor(0x11151c, 0x8a8f95, 1 - lighting.night),
      );
    }
    // Painted road markings are lit, but a pure white Lambert still reads
    // brighter than the night street and feeds the bloom. Dim the whole paint
    // material with the same night factor; daylight stays pure white.
    const paint = 1 - 0.72 * lighting.night;
    crosswalkMaterial.color.setScalar(paint);
    roadMarkingMaterial.color.setScalar(paint);
    if (this.customLayer.renderer) {
      this.customLayer.renderer.toneMappingExposure = lighting.exposure;
    }
    // the window shader reads the same key light, so the glass tracks dawn/dusk
    windowMaterial.uniforms.uNight.value = lighting.night;
    windowMaterial.uniforms.uKeyDirection.value
      .set(...lighting.keyDirection)
      .normalize();
    windowMaterial.uniforms.uKeyColor.value.setHex(lighting.keyColor);
    windowMaterial.uniforms.uKeyIntensity.value = lighting.keyIntensity;
    windowMaterial.uniforms.uAmbientColor.value.setHex(lighting.skyColor);
    windowMaterial.uniforms.uAmbientIntensity.value =
      lighting.hemisphereIntensity;
    // glass walls read the same sun and sky as the windows, so a curtain wall
    // reflects the same dawn and goes just as dark at night
    glassMaterial.uniforms.uNight.value = lighting.night;
    glassMaterial.uniforms.uKeyDirection.value
      .set(...lighting.keyDirection)
      .normalize();
    glassMaterial.uniforms.uKeyColor.value.setHex(lighting.keyColor);
    glassMaterial.uniforms.uKeyIntensity.value = lighting.keyIntensity;
    glassMaterial.uniforms.uAmbientColor.value.setHex(lighting.skyColor);
    glassMaterial.uniforms.uAmbientIntensity.value =
      lighting.hemisphereIntensity;
    waterMaterial.uniforms.uNight.value = lighting.night;
    fountainWaterMaterial.uniforms.uNight.value = lighting.night;
    // the glitter on the water is the same key light the windows get: its
    // color warms at the horizon and its direction is the real sun, so the
    // reflection sits under the sun instead of wherever the bands happen to be
    waterMaterial.uniforms.uSunDirection.value
      .set(...lighting.keyDirection)
      .normalize();
    waterMaterial.uniforms.uSunColor.value.setHex(lighting.keyColor);
    waterMaterial.uniforms.uSunIntensity.value = lighting.keyIntensity;
    greenMaterial.uniforms.uNight.value = lighting.night;
    this.clouds?.setNight(lighting.night);
    // the fog and the MapLibre sky follow the same palette as the lights, so
    // distant geometry dissolves into the horizon instead of stopping abruptly
    if (this.customLayer.scene.fog instanceof THREE.Fog) {
      this.customLayer.scene.fog.color.setHex(lighting.skyFog);
    }
    if (this.shadowGround) {
      this.shadowGround.visible = !this.softwareRenderer;
      const material = this.shadowGround.material as THREE.ShadowMaterial;
      material.opacity = Math.min(0.4, 0.15 * lighting.keyIntensity);
    }
    this.applySky(lighting);
    this.applyNightLightsVisibility();
    this.refreshSunShadow();
    const grade = document.querySelector<HTMLElement>("#grade");
    if (grade) {
      grade.style.backgroundColor = `#${lighting.gradeColor
        .toString(16)
        .padStart(6, "0")}`;
      grade.style.opacity = String(lighting.gradeOpacity);
    }
    this.applyBasemap(lighting.night > BASEMAP_NIGHT_AT);
  }

  // MapLibre's sky/atmosphere: a gradient from the zenith to the horizon with
  // fog, warmed through sunrise/sunset and deep blue at night.
  private applySky(lighting: Lighting) {
    if (!this.map.isStyleLoaded()) return;
    const hex = (color: number) => `#${color.toString(16).padStart(6, "0")}`;
    this.map.setSky({
      "sky-color": hex(lighting.skyTop),
      "horizon-color": hex(lighting.skyHorizon),
      "fog-color": hex(lighting.skyFog),
      "sky-horizon-blend": 0.6,
      "horizon-fog-blend": 0.45,
      "fog-ground-blend": 0.6,
      "atmosphere-blend": 1,
    });
  }

  // Reposition the sun and its shadow camera and request one shadow-map
  // render. Debounced: a burst of tile loads (each one would otherwise trigger
  // a full 2.4M-caster shadow pass) coalesces into one, and the view settling
  // updates it once.
  private refreshSunShadow() {
    if (!this.sunLight || this.softwareRenderer) return;
    if (this.shadowTimer !== undefined) clearTimeout(this.shadowTimer);
    this.shadowTimer = setTimeout(() => {
      this.shadowTimer = undefined;
      this.applySunShadow();
    }, 200);
  }

  private applySunShadow() {
    if (!this.sunLight || this.softwareRenderer) return;
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    const center = this.map.getCenter();
    const [x, y] = toModelCoords(
      [center.lng, center.lat],
      originMeters,
      scaleFactor,
    );
    const direction = this.lighting.keyDirection;
    this.sunLight.target.position.set(x, y, 0);
    this.sunLight.target.updateMatrixWorld();
    this.sunLight.position.set(
      x + direction[0] * 3000,
      y + direction[1] * 3000,
      direction[2] * 3000,
    );
    this.sunLight.updateMatrixWorld();
    if (this.customLayer.renderer) {
      this.customLayer.renderer.shadowMap.needsUpdate = true;
    }
  }

  // Swap the basemap to the dark MapTiler style at night (and back by day).
  // setStyle diffs, so the custom layer usually survives it; the style.load
  // handler and onAdd are both written to tolerate a re-add just in case.
  // Remembering the mounted style keeps the swap to once per crossing, not on
  // every lighting update.
  private setBasemapEnabled(on: boolean) {
    if (on === this.basemapEnabled) return;
    this.basemapEnabled = on;
    const fade = document.querySelector<HTMLElement>("#basemap-fade");
    if (fade) fade.style.opacity = "0";
    if (on) {
      const night = this.lighting.night > BASEMAP_NIGHT_AT;
      this.darkBasemap = night;
      this.map.setStyle(basemapStyleUrl(night ? BASEMAP_NIGHT : BASEMAP_DAY));
    } else {
      this.map.setStyle(EMPTY_BASEMAP_STYLE);
    }
  }

  private applyBasemap(night: boolean) {
    if (!this.basemapEnabled) return;
    if (night === this.darkBasemap) return;
    this.darkBasemap = night;
    const fade = document.querySelector<HTMLElement>("#basemap-fade");
    if (!fade) {
      this.map.setStyle(basemapStyleUrl(night ? BASEMAP_NIGHT : BASEMAP_DAY));
      return;
    }
    // fade through black, swap under the cover, then reveal the new style
    fade.style.opacity = "1";
    let done = false;
    const reveal = () => {
      if (done) return;
      done = true;
      fade.style.opacity = "0";
    };
    setTimeout(() => {
      this.map.once("style.load", reveal);
      this.map.setStyle(basemapStyleUrl(night ? BASEMAP_NIGHT : BASEMAP_DAY));
      // the style load is normally quick; do not stay black if it never fires
      setTimeout(reveal, 900);
    }, 230);
  }

  // read-only day/night state for the e2e test (like stats()): the current
  // hour, the 0..1 night factor and the key-light intensity
  lightingState(): { hour: number; night: number; sunIntensity: number } {
    return {
      hour: this.timeOfDay,
      night: this.lighting.night,
      sunIntensity: this.lighting.keyIntensity,
    };
  }

  // the clouds are anchored in the world and fade out as the map zooms in;
  // like the fleets they are recomputed every frame, in the same projection
  private updateClouds(originMeters: [number, number], scaleFactor: number) {
    if (!this.clouds) return;
    this.clouds.update(originMeters, scaleFactor, {
      zoom: this.map.getZoom(),
      center: epsg4326toEpsg3857([
        this.map.getCenter().lng,
        this.map.getCenter().lat,
      ]),
      now: performance.now(),
    });
  }

  // hand the union of the loaded tiles' precomputed loops to the renderers,
  // split by kind (both get the crossing points; only the car loops pass them)
  private syncTraffic() {
    const loops = Object.values(this.loadedTraffic).flat();
    const crossings = Object.values(this.loadedCrossings).flat();
    this.carsTraffic?.setLoops(
      loops.filter((loop) => loop.kind === "car"),
      crossings,
    );
    this.trainsTraffic?.setLoops(
      loops.filter((loop) => loop.kind === "train"),
      crossings,
    );
    this.busesTraffic?.setLoops(
      loops.filter((loop) => loop.kind === "bus"),
      crossings,
    );
    this.tramsTraffic?.setLoops(
      loops.filter((loop) => loop.kind === "tram"),
      crossings,
    );
  }

  // hand the plane layer the loaded runways (as flight paths) and aprons (as
  // parking). A runway or apron stored whole repeats across the tiles it spans,
  // so dedupe by id here (the first copy wins; they are the same geometry).
  private syncAirplanes() {
    if (!this.airplanes) return;
    const runwaysById = new Map<string, RunwayLine>();
    for (const runways of Object.values(this.loadedRunways)) {
      for (const runway of runways) {
        if (!runwaysById.has(runway.id)) runwaysById.set(runway.id, runway);
      }
    }
    const apronsById = new Map<string, ApronRing>();
    for (const aprons of Object.values(this.loadedAprons)) {
      for (const apron of aprons) {
        if (!apronsById.has(apron.id)) apronsById.set(apron.id, apron);
      }
    }
    this.airplanes.setRunways([...runwaysById.values()]);
    this.airplanes.setAprons([...apronsById.values()].map((a) => a.ring));
  }

  // Parked cars follow the facade detail: only the tiles around the centre and
  // only above the windows zoom. The full loaded window is seven tiles across,
  // which would be hundreds of thousands of cars almost all off-screen; the
  // 3x3 center is what is actually in view at this zoom. The layer keeps one
  // mesh per tile and diffs the window, so a move builds only the tiles that
  // entered it.
  private syncParkedCars() {
    if (!this.parkedCars) return;
    if (this.map.getZoom() < FACADE_MIN_ZOOM) {
      this.applyParkedCarVisibility();
      return;
    }
    const [cx, cy] = getTileIndex(this.map.getCenter());
    const tiles: ParkedTile[] = [];
    for (let x = cx - FACADE_TILE_MARGIN; x <= cx + FACADE_TILE_MARGIN; x++) {
      for (let y = cy - FACADE_TILE_MARGIN; y <= cy + FACADE_TILE_MARGIN; y++) {
        const key = `${x}_${y}`;
        const spots = this.loadedParking[key];
        if (spots) tiles.push({ key, spots });
      }
    }
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    // the distance LOD follows the view center: cars within
    // PARKED_CAR_DETAIL_RADIUS get the full body, the rest a box. The layer
    // quantizes this, so only a meaningful move rebuilds the split.
    const center = this.map.getCenter();
    const detailCenter = toModelCoords(
      [center.lng, center.lat],
      originMeters,
      scaleFactor,
    );
    this.parkedCars.setTiles(tiles, originMeters, scaleFactor, detailCenter);
    this.applyParkedCarVisibility();
  }

  private applyParkedCarVisibility() {
    const on = this.parkedCarsEnabled && this.map.getZoom() >= FACADE_MIN_ZOOM;
    this.parkedCars?.setEnabled(on);
  }

  // The signal heads (and, later, street lamps) for the centre tiles. Rebuilt
  // only when that set or the origin changes; the glow is visibility-gated by
  // night and zoom in the layer.
  private syncNightLights() {
    if (!this.nightLights) return;
    const [cx, cy] = getTileIndex(this.map.getCenter());
    const tiles: NightLightTile[] = [];
    for (let x = cx - FACADE_TILE_MARGIN; x <= cx + FACADE_TILE_MARGIN; x++) {
      for (let y = cy - FACADE_TILE_MARGIN; y <= cy + FACADE_TILE_MARGIN; y++) {
        const key = `${x}_${y}`;
        const lamps = this.loadedLamps[key] ?? [];
        const signals = this.loadedSignals[key] ?? [];
        if (lamps.length > 0 || signals.length > 0) {
          // the raw per-tile arrays are the identity the layer diffs on, so do
          // not copy them here
          tiles.push({ key, lamps, signals });
        }
      }
    }
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    this.nightLights.setTiles(tiles, originMeters, scaleFactor);
    this.applyNightLightsVisibility();
  }

  private applyNightLightsVisibility() {
    this.nightLights?.setLampsEnabled(this.lamppostsEnabled);
    this.nightLights?.setVisible(this.lighting.night, this.map.getZoom());
  }

  private recordFrame(now: number) {
    if (!PERF_ENDPOINT) return;
    this.frameTimes.push(now);
    const cutoff = now - 2000;
    while (this.frameTimes.length > 1 && this.frameTimes[0] < cutoff) {
      this.frameTimes.shift();
    }
    const elapsed = now - this.frameTimes[0];
    this.fpsValue =
      elapsed > 0 ? ((this.frameTimes.length - 1) * 1000) / elapsed : 0;
  }

  private perfPayload(extra: Record<string, unknown> = {}) {
    return {
      browser: browserName(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      webgpu: webGPUSupported(),
      fps: Math.round(this.fpsValue * 10) / 10,
      checkboxes: checkboxStates(),
      ...extra,
    };
  }

  private reportPerf(extra: Record<string, unknown> = {}) {
    if (!PERF_ENDPOINT) return;
    // diagnostics must never break the map: a missing collector or an offline
    // page is a no-op, not an unhandled rejection
    void fetch(PERF_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.perfPayload(extra)),
      keepalive: true,
    }).catch(() => {});
  }

  // read-only counters for the perf benchmark (perf/frame_times.spec.ts); the
  // app itself never calls this
  stats(): {
    tiles: number;
    meshes: number;
    vertices: number;
    drawCalls: number;
    triangles: number;
    byKind: Record<
      string,
      { meshes: number; vertices: number; triangles: number }
    >;
    buildings: number;
    vehicles: number;
    trains: number;
    facadeTiles: number;
    facadeVertices: number;
    parkedCars: number;
    parkedCarTiles: number;
    parkedCarMeshes: number;
    parkedCarTriangles: number;
    nightLightTiles: number;
    nightLightMeshes: number;
    vehiclesDrawn: number;
    trainsDrawn: number;
    buses: number;
    trams: number;
    busesDrawn: number;
    tramsDrawn: number;
  } {
    let meshes = 0;
    let vertices = 0;
    const byKind: Record<
      string,
      { meshes: number; vertices: number; triangles: number }
    > = {};
    for (const list of Object.values(this.loadedTiles)) {
      meshes += list.length;
      for (const object of list) {
        if (
          !(object instanceof THREE.Mesh) &&
          !(object instanceof THREE.LineSegments)
        ) {
          continue;
        }
        const kind = (object.userData.kind as string) ?? "other";
        const bucket = (byKind[kind] ??= {
          meshes: 0,
          vertices: 0,
          triangles: 0,
        });
        const position = object.geometry.getAttribute("position");
        const count = position ? position.count : 0;
        bucket.meshes += 1;
        bucket.vertices += count;
        bucket.triangles +=
          object instanceof THREE.LineSegments
            ? 0
            : object.geometry.index
              ? object.geometry.index.count / 3
              : count / 3;
        vertices += count;
      }
    }
    let facadeTiles = 0;
    let facadeVertices = 0;
    for (const detail of Object.values(this.loadedDetail)) {
      for (const mesh of [detail.windows, detail.balconies]) {
        if (!mesh) continue;
        facadeTiles += 1;
        facadeVertices += mesh.geometry.getAttribute("position")?.count ?? 0;
      }
    }
    return {
      tiles: Object.keys(this.loadedTiles).length,
      meshes,
      vertices,
      // last frame's scene, captured before the bloom quads overwrite
      // renderer.info
      drawCalls: this.lastSceneDraw.calls,
      triangles: this.lastSceneDraw.triangles,
      byKind,
      buildings: Object.values(this.loadedBuildings).reduce(
        (n, b) => n + b.length,
        0,
      ),
      vehicles: this.carsTraffic?.count ?? 0,
      trains: this.trainsTraffic?.count ?? 0,
      facadeTiles,
      facadeVertices,
      parkedCars: this.parkedCars?.count ?? 0,
      parkedCarTiles: this.parkedCars?.tileCount ?? 0,
      parkedCarMeshes: this.parkedCars?.meshCount ?? 0,
      parkedCarTriangles: this.parkedCars?.triangles ?? 0,
      nightLightTiles: this.nightLights?.tileCount ?? 0,
      nightLightMeshes: this.nightLights?.meshCount ?? 0,
      vehiclesDrawn: this.carsTraffic?.drawnCount ?? 0,
      trainsDrawn: this.trainsTraffic?.drawnCount ?? 0,
      buses: this.busesTraffic?.count ?? 0,
      trams: this.tramsTraffic?.count ?? 0,
      busesDrawn: this.busesTraffic?.drawnCount ?? 0,
      tramsDrawn: this.tramsTraffic?.drawnCount ?? 0,
    };
  }

  async getGLTF(): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((res, rej) => {
      const exporter = new GLTFExporter();
      exporter.parse(
        this.customLayer.scene,
        function (gltf) {
          if (gltf instanceof ArrayBuffer) {
            res(gltf);
          } else {
            rej(["This is not an ArrayBuffer!", gltf]);
          }
        },
        function (error) {
          rej(error);
        },
        { binary: true },
      );
    });
  }

  // console.log("transform", modelTransform)

  // function getCube100(x: number, y: number): THREE.Mesh {
  //      const geometry = new THREE.BoxGeometry( 100, 100, 100 );
  //     // const material = new THREE.MeshToonMaterial( {color: 0x00ff00} );
  //     const material = new THREE.MeshStandardMaterial({
  //         color: 0x10ff10,
  //         transparent: true,
  //         opacity: 0.9
  //         // wireframe: true
  //     });
  //     const cube = new THREE.Mesh(geometry, material );
  //     cube.translateZ(50);
  //     cube.translateX(x);
  //     cube.translateY(y);
  //     return cube;
  // }
}

restoreCheckboxStates();
const c = new CoolMap([9.186, 45.497]);

// dev-only handle for the perf benchmark (perf/frame_times.spec.ts); stripped
// from production builds by the import.meta.env.DEV guard
if (import.meta.env.DEV) {
  (window as unknown as { __coolMap: CoolMap }).__coolMap = c;
}
// example of how to download GLTF file
// setTimeout(async () => {
//   const data = await c.getGLTF();
//   const blob = new Blob([data], { type: "model/gltf-binary" });
//   const link = document.createElement("a");
//   link.href = window.URL.createObjectURL(blob);
//   link.download = "gltf.glb";
//   link.click();
// }, 5000);
