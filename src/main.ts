import {
  GeolocateControl,
  Map as MapLibreMap,
  MercatorCoordinate,
  NavigationControl,
  ScaleControl,
} from "maplibre-gl";
import * as THREE from "three";
import "./maplibre_setup";

import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

import type { CustomLayerInterface, LngLat, LngLatLike } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import {
  epsg4326toEpsg3857,
  getTileIndex,
  scaleFactorAt,
  toModelCoords,
} from "./projection.ts";
import {
  PERF_ENDPOINT,
  PerfReporter,
  sceneStats,
  type SceneStats,
} from "./perf.ts";
import { TileLoader, disposeFacadeDetail } from "./tile_loader.ts";
import {
  BASEMAP_DAY,
  BASEMAP_NIGHT,
  BASEMAP_NIGHT_AT,
  BLOOM_NIGHT_AT,
  LightingRig,
  basemapStyleUrl,
  initialHour,
  isNightHour,
} from "./lighting.ts";
import { DriveMode } from "./drive_mode.ts";
import type { MapDebug, ModelTransform } from "./debug.ts";
import { Selection } from "./selection.ts";
import type { TileRecord } from "./tile_record.ts";
import { DAY_HOUR, NIGHT_HOUR } from "./daynight.ts";
import { escapeHtml } from "./ui/html.ts";
import { restoreCheckboxStates, savedCheckbox } from "./ui/checkboxes.ts";
import {
  onCheckboxChange,
  wireControls,
  wireImputedHelp,
  wireLayerMenu,
} from "./ui/controls.ts";
import type {
  ApronRing,
  BuildingInfo,
  RunwayLine,
  TrafficLoop,
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
import { BloomPass } from "./bloom.ts";
import { CloudLayer } from "./clouds.ts";
import { PlaneLayer } from "./airplanes.ts";
import {
  facadeMaterial,
  tileFacadeDetail,
  windowMaterial,
} from "./elements3d/facade.ts";
import { fountainWaterMaterial } from "./elements3d/fountain.ts";
import { greenMaterial } from "./elements3d/green.ts";
import { cameraCenter, waterMaterial } from "./elements3d/water.ts";
import { treeSway } from "./elements3d/tree_material.ts";

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
// hovering raycasts the pickable sets; 12 Hz reads as instant and costs a
// twelfth of what per-frame would
const HOVER_THROTTLE_MS = 80;
// sidewalks are a street-level detail; the slabs are cheap but there are many
const SIDEWALK_MIN_ZOOM = 16;
// lane paint only reads once the road is wide enough on screen to carry it
const LANE_MIN_ZOOM = 16;
// One per-tile layer whose checkbox is a plain visibility switch.
interface LayerSwitch {
  id: string;
  kinds: string[];
  /** the checkbox label's id that drives it */
  toggle: string;
  /** store the flag; wired straight into the checkbox */
  set: (on: boolean) => void;
  /** when to draw, including the zoom gate */
  visible: () => boolean;
  /** anything else that follows the same switch */
  after?: () => void;
}

// ringContains / ringDistance live in feature_pick.ts: the generic picker and
// the click handler share them

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

class CoolMap implements MapDebug {
  tileCenter: [number, number];
  map: MapLibreMap;
  private customLayer: ThreeJSLayerInterface;
  // the tile window: fetching, retention, disposal and the store
  private readonly loader: TileLoader;
  // the loader owns the store; this keeps the read path (`this.tiles`) and the
  // e2e's `map.tiles` on the same map
  get tiles(): Map<string, TileRecord> {
    return this.loader.tiles;
  }

  // the 3D scene and camera the layer draws with; the e2e counts meshes and
  // projects model points through them
  get scene(): THREE.Scene {
    return this.customLayer.scene;
  }

  get camera(): THREE.Camera {
    return this.customLayer.camera;
  }

  // a copy, so a spec cannot reach in and move the origin
  get originTransform(): ModelTransform {
    return { ...this.modelTransform };
  }

  // the click popups and the ground rings; it reads the tile store and the
  // scene above, so it is created in the constructor once they exist
  private readonly selection: Selection;
  // hovering is a per-frame raycast, so it is opt-in and throttled
  private hoverEnabled = false;
  private lastHoverAt = 0;

  // read-only probe for the e2e specs: open a building's popup without a click
  selectBuilding(info: BuildingInfo, lngLat: LngLatLike): void {
    this.selection.selectBuilding(info, lngLat);
  }
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
  // frame timing and the diagnostic report
  private readonly perf = new PerfReporter();
  // layer checkboxes
  private windowsEnabled = true;
  private balconiesEnabled = true;
  private roofShapesEnabled = true;
  // water is its own per-tile mesh, so this is a plain visibility switch
  private waterEnabled = true;
  // benches are their own per-tile mesh too
  private benchesEnabled = true;
  // lane paint: per-tile line sets, gated on the zoom
  private lanesEnabled = true;
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
  // car mode: the keys, the touch pad, the chase camera and the map handlers
  // it borrows while driving
  private readonly drive: DriveMode;
  private clouds?: CloudLayer;
  private airplanes?: PlaneLayer;
  // the scene lights, kept so the time-of-day model can drive them. They are
  // created in onAdd (with the renderer) and are undefined until then.
  // the lights, the ground, the shadow catcher and the basemap swap
  private readonly light: LightingRig;
  // headless CI runs on SwiftShader; the shadow pass is not worth it there
  private softwareRenderer = false;
  // hours 0..24, local mean solar time at Milan; seeded from the real sun and
  // driven by the slider/night checkbox afterwards. The slider steps 0.25 h, so
  // round the seed to match rather than give the thumb a fractional value.

  // which basemap is mounted, so a night/day flip only swaps the style once

  // the basemap checkbox; while off the map keeps an empty style and only the
  // 3D custom layer is drawn

  // user toggle (the page checkbox); combined with the zoom gate
  private trafficEnabled = true;
  // whether clicking a building inspects it
  private inspectEnabled = true;
  // user toggle for the decorative cloud layer (also gated on the zoom)
  private cloudsEnabled = true;
  // move fires continuously; debounce the tile load/unload pass
  private moveDebounce: ReturnType<typeof setTimeout> | undefined;

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
    // one scene for the custom layer and the selection rings
    const selectionScene = new THREE.Scene();
    // A saved day/night switch wins over the solar seed, so the first basemap
    // is the one the user last chose instead of a frame of the other one.
    const hour = initialHour(savedCheckbox("night-toggle"));
    this.map = new MapLibreMap({
      container: "central-map",
      center: tileCenter,
      zoom: zoomLevel,
      pitch: 30,
      // keep the view in the URL as OSM does ("#map=zoom/lat/lon"), so a
      // position can be linked; the prefix makes maplibre use that shape, and
      // it reads a fragment pasted on load and updates it as the map moves
      hash: "map",
      // open on the basemap the current sun calls for, so the day style does
      // not flash before the first apply() swaps it
      style: basemapStyleUrl(isNightHour(hour) ? BASEMAP_NIGHT : BASEMAP_DAY),
    });
    // the projection origin follows whatever the map actually opened on (a
    // #map= fragment may have moved it), so no tiles are fetched for the
    // default center first
    const opened = this.map.getCenter();
    this.tileCenter = [opened.lng, opened.lat];
    // the click handling needs the map; the scene arrives with the custom layer
    // below, so it is reached through a getter rather than captured here
    this.loader = new TileLoader({
      scene: selectionScene,
      origin: () => this.tileCenter,
      viewCenter: () => this.map.getCenter(),
      imputedColors: () => this.imputedColorsEnabled,
      onOriginDrift: (center) => this.resetOrigin(center),
      onTilesChanged: () => this.syncTileLayers(),
      onTileAdded: () => this.syncAfterTileLoad(),
      onReload: () => {
        this.parkedCars?.clear();
        this.syncTraffic();
        this.syncAirplanes();
        this.syncNightLights();
        this.light.refreshSunShadow();
      },
    });
    this.drive = new DriveMode(
      {
        map: this.map,
        tiles: this.tiles,
        barrierBlocks: (kind) =>
          (kind !== "fence" || this.fencesEnabled) &&
          (kind !== "wall" || this.wallsEnabled),
        catchUpTiles: () => {
          this.loader.load(this.map.getCenter());
          this.syncBuildingDetail();
        },
        refreshSunShadow: () => this.light.refreshSunShadow(),
        onExit: () => {
          this.loader.load(this.map.getCenter());
          this.syncBuildingDetail();
          this.light.refreshSunShadow();
        },
        reportPerf: (event) => this.reportPerf(event),
        clearSelection: () => this.selection.clear(),
        stopFollowing: () => this.stopFollowing(),
      },
      selectionScene,
    );
    this.drive.wire();
    this.light = new LightingRig(
      {
        map: this.map,
        scene: selectionScene,
        renderer: () => this.customLayer.renderer,
        center: () => this.tileCenter,
        onNight: (night: number) => {
          this.clouds?.setNight(night);
          this.applyNightLightsVisibility();
        },
      },
      hour,
    );
    this.selection = new Selection({
      tiles: this.tiles,
      map: this.map,
      get scene() {
        return selectionScene;
      },
      center: () => this.tileCenter,
      rooftopsVisible: () => this.rooftopsEnabled,
    });
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
      scene: selectionScene,
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

        // the lights, the ground and the shadow catcher belong to the rig,
        // which is built with the scene; it reads the renderer through its host
        // (it is created further down this callback) and needs the SwiftShader
        // verdict to decide about the shadow pass
        coolMap.light.setSoftwareRenderer(coolMap.softwareRenderer);

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
        // animated cars and trains, added to the scene directly — not part of
        // any tile — so the origin reset does not touch them; their positions
        // are recomputed each frame from the precomputed loops
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
        coolMap.light.apply();
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
      // the renderer owns its own GL context; this argument is unused
      render(_gl, args) {
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
        coolMap.drive.update(originMeters, scaleFactor);
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
            coolMap.light.night > BLOOM_NIGHT_AT
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
      this.loader.load(this.map.getCenter());
      this.applyTrafficState();
      // a style swap drops the sky; re-apply the current time-of-day state
      coolMap.light.apply();
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
        this.loader.load(this.map.getCenter());
        this.syncBuildingDetail();
        this.light.refreshSunShadow();
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
        if (!this.inspectEnabled) this.selection.clear();
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
        nightToggle.checked = this.light.night > BASEMAP_NIGHT_AT;
      }
      if (timeSlider) timeSlider.value = String(this.light.timeOfDay);
    };
    nightToggle?.addEventListener("change", () => {
      this.light.setTimeOfDay(nightToggle.checked ? NIGHT_HOUR : DAY_HOUR);
      syncTimeControls();
    });
    timeSlider?.addEventListener("input", () => {
      this.light.setTimeOfDay(Number(timeSlider.value));
      syncTimeControls();
    });
    syncTimeControls();

    // One row per checkbox: what it stores and what it re-applies. The layer
    // rows come straight from `layerSwitches`, so a layer's checkbox id, mesh
    // kinds and flag stay in one place; the rest are switches with no meshes.
    wireControls([
      ...this.layerSwitches.map((layer) => ({
        id: layer.toggle,
        set: layer.set,
        apply: () => this.applyLayer(layer.id),
      })),
      { id: "#traffic-toggle", set: (on) => this.setTrafficEnabled(on) },
      {
        id: "#inspect-toggle",
        set: (on) => (this.inspectEnabled = on),
        apply: () => {
          if (!this.inspectEnabled) this.selection.clear();
        },
      },
      {
        id: "#hover-inspect-toggle",
        set: (on) => (this.hoverEnabled = on),
        apply: () => {
          if (this.hoverEnabled) return;
          this.selection.clearHover();
          const canvas = this.map.getCanvas();
          if (canvas.style.cursor) canvas.style.cursor = "";
        },
      },
      { id: "#clouds-toggle", set: (on) => this.setCloudsEnabled(on) },
      {
        id: "#basemap-toggle",
        set: (on) => this.light.setBasemapEnabled(on),
      },
      { id: "#bloom-toggle", set: (on) => (this.bloomEnabled = on) },
      {
        id: "#windows-toggle",
        set: (on) => (this.windowsEnabled = on),
        apply: () => this.applyDetailVisibility(),
      },
      {
        id: "#balconies-toggle",
        set: (on) => (this.balconiesEnabled = on),
        apply: () => this.applyDetailVisibility(),
      },
      {
        id: "#parked-cars-toggle",
        set: (on) => (this.parkedCarsEnabled = on),
        apply: () => this.applyParkedCarVisibility(),
      },
      {
        id: "#lampposts-toggle",
        set: (on) => (this.lamppostsEnabled = on),
        apply: () => this.applyNightLightsVisibility(),
      },
      {
        id: "#imputed-colors-toggle",
        set: (on) => {
          if (on === this.imputedColorsEnabled) return;
          // the color is baked into the geometry, so the loaded tiles have to
          // be rebuilt: drop them and fetch them again
          this.imputedColorsEnabled = on;
          void this.loader.reload();
        },
      },
    ]);

    const setMenuOpen = wireLayerMenu();
    wireImputedHelp();
    onCheckboxChange(() => this.reportPerf({ event: "toggle" }));

    this.map.on("click", (event) => this.onMapClick(event));
    this.map.on("dragstart", () => this.stopFollowing());
    this.map.on("mousemove", (event) => this.onHover(event));
    // leaving the canvas must drop the ring, or it lingers where the mouse left
    this.map.on("mouseout", () => this.selection.clearHover());

    // car mode wires its own button; the Drive row lives in the menu, so using
    // it should get the panel out of the way for the chase camera
    document
      .querySelector("#drive-button")
      ?.addEventListener("click", () => setMenuOpen(false));

    const scheduleInitialReport = () => {
      if (!PERF_ENDPOINT) return;
      window.setTimeout(() => this.reportPerf(), 12000);
    };
    if (document.readyState === "complete") scheduleInitialReport();
    else window.addEventListener("load", scheduleInitialReport, { once: true });
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
    if (this.drive.active) return;
    if (!this.inspectEnabled) return;
    const raycaster = this.rayAt(event.point);
    const hits = raycaster.intersectObjects(
      this.selection.pickableMeshes(),
      true,
    );
    // a GTFS vehicle is in its own instanced mesh, so it is not in the static
    // pickable list; compare its ray distance with the nearest static hit
    const vehicle = this.vehicleAt(raycaster);
    if (hits.length === 0) {
      if (vehicle) this.selectVehicle(vehicle, event.lngLat);
      else this.selection.clear();
      return;
    }
    const hit = hits[0];
    if (vehicle && vehicle.distance < hit.distance) {
      this.selectVehicle(vehicle, event.lngLat);
      return;
    }
    this.selection.pickStatic(hit, event.lngLat);
  }

  // resolve a static hit to what the user clicked: a point feature, a fence or
  // wall, a generic OSM feature, a solar panel, or the building below it
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
    this.selection.clear();
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
    const popup = this.selection.showPopup(lngLat, lines);
    popup?.on("close", () => this.stopFollowing());
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
    this.selection.reposition([position.lon, position.lat]);
  }

  // ---- car mode -----------------------------------------------------------
  // The car is a pure lon/lat state advanced every frame by updateDriving; the
  // camera chases it with jumpTo and the obstacle predicate comes from the
  // loaded tiles. There is no road graph: this is a free joyride over the 3D
  // city, not a driving simulation.

  // the layers that hold a union of the loaded tiles have to be re-fed
  // whenever that union changes
  private syncTileLayers() {
    this.syncTraffic();
    this.syncAirplanes();
    this.syncParkedCars();
    this.syncNightLights();
    this.light.refreshSunShadow();
  }

  // one tile arrived: its routes, its runways, its facade detail and the
  // switches it may have missed while it was in flight
  private syncAfterTileLoad() {
    this.syncTraffic();
    this.syncAirplanes();
    this.syncBuildingDetail();
    // a tile can arrive after its checkbox was toggled, so it picks up the
    // current switches here (this covers the power and park-path layers too)
    this.applyTileVisibility();
    this.light.refreshSunShadow();
  }

  // A ray through a point on the canvas. MapLibre bakes the view into the
  // projection matrix, so build it from two unprojected points instead of
  // setFromCamera (which assumes the camera sits at the world origin).
  private rayAt(point: { x: number; y: number }): THREE.Raycaster {
    const canvas = this.map.getCanvas();
    // point is already in CSS pixels relative to the map canvas
    const ndc = new THREE.Vector2(
      (point.x / canvas.clientWidth) * 2 - 1,
      -(point.y / canvas.clientHeight) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    const inv = this.customLayer.camera.projectionMatrixInverse;
    const near = new THREE.Vector3(ndc.x, ndc.y, -1).applyMatrix4(inv);
    const far = new THREE.Vector3(ndc.x, ndc.y, 1).applyMatrix4(inv);
    raycaster.set(near, far.sub(near).normalize());
    return raycaster;
  }

  // Mouse over the map: ring whatever is under the cursor and turn it into a
  // pointer. Throttled because it raycasts the whole pickable set, and off while
  // driving, where the map belongs to the car.
  private onHover(event: { point: { x: number; y: number } }): void {
    if (!this.hoverEnabled || this.drive.active) return;
    const now = performance.now();
    if (now - this.lastHoverAt < HOVER_THROTTLE_MS) return;
    this.lastHoverAt = now;
    const hits = this.rayAt(event.point).intersectObjects(
      this.selection.pickableMeshes(),
      true,
    );
    const kind = this.selection.hover(hits[0]);
    const cursor = kind ? "pointer" : "";
    const canvas = this.map.getCanvas();
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  }

  // read-only hover state for the e2e (like stats())
  hoverState(): { kind: string | null } {
    return { kind: this.selection.hoverKind };
  }

  // read-only collision probe for the e2e: whether a car at this position and
  // heading would hit a building or a visible barrier
  collisionAt(lon: number, lat: number, heading = 0): boolean {
    return this.drive.blocked({ lon, lat, heading, speed: 0 });
  }

  // read-only day/night state for the e2e (like stats())
  lightingState(): { hour: number; night: number; sunIntensity: number } {
    return this.light.readState();
  }

  // read-only shadow state for the GPU health check
  shadowState(): { castsShadow: boolean; baked: boolean } {
    return this.light.readShadowState();
  }

  // read-only state for the e2e (like lightingState() and stats())
  driveState(): {
    active: boolean;
    lon: number;
    lat: number;
    heading: number;
    speed: number;
  } {
    return this.drive.state();
  }

  private resetOrigin(center: { lng: number; lat: number }) {
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
    this.loader.forEachMesh((mesh) => mesh.applyMatrix4(remap));

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
    this.selection.clear();
    // the facade detail is baked in the old origin's space too; drop it and let
    // the next sync rebuild it against the new origin
    this.clearBuildingDetail();
    // in-flight loads were baked against the old origin, so discard them and
    // clear their bookkeeping to let the load loop request them again
    this.loader.invalidate();
    this.syncParkedCars();
    this.syncNightLights();
    this.light.refreshSunShadow();
    console.log("reset projection origin to", center.lng, center.lat);
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
        const record = this.tiles.get(key);
        // not loaded yet: loadTile runs this again when it arrives
        if (!record || record.detail) continue;
        const originMeters = epsg4326toEpsg3857(this.tileCenter);
        const scaleFactor = scaleFactorAt(this.tileCenter[1]);
        const detail = tileFacadeDetail(
          originMeters,
          scaleFactor,
          record.objects.buildings,
        );
        record.detail = {
          windows: this.addDetailMesh(key, "windows", detail.windows),
          balconies: this.addDetailMesh(key, "balconies", detail.balconies),
        };
      }
    }
    for (const [key, record] of this.tiles) {
      if (keep.has(key) || !record.detail) continue;
      this.disposeDetail(record.detail);
      record.detail = undefined;
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
    for (const { detail } of this.tiles.values()) {
      if (!detail) continue;
      if (detail.windows) detail.windows.visible = this.windowsEnabled;
      if (detail.balconies) detail.balconies.visible = this.balconiesEnabled;
    }
  }

  // Every per-tile layer whose checkbox is a plain visibility switch: the mesh
  // kinds it owns, when it should be drawn, and anything else that follows the
  // same switch (the airplane layer has both tarmac meshes and planes). One row
  // per layer replaced an `apply...Visibility` method each, which is where the
  // checkboxes kept drifting out of step with the meshes.
  private readonly layerSwitches: LayerSwitch[] = [
    {
      id: "roof",
      kinds: ["roof"],
      toggle: "#roof-shapes-toggle",
      set: (on) => (this.roofShapesEnabled = on),
      visible: () => this.roofShapesEnabled,
    },
    {
      id: "water",
      kinds: ["water"],
      toggle: "#water-toggle",
      set: (on) => (this.waterEnabled = on),
      visible: () => this.waterEnabled,
    },
    {
      id: "bench",
      kinds: ["bench"],
      toggle: "#benches-toggle",
      set: (on) => (this.benchesEnabled = on),
      visible: () => this.benchesEnabled,
    },
    {
      id: "church",
      kinds: ["church"],
      toggle: "#churches-toggle",
      set: (on) => (this.churchesEnabled = on),
      visible: () => this.churchesEnabled,
    },
    {
      id: "green",
      kinds: ["green"],
      toggle: "#parks-toggle",
      set: (on) => (this.parksEnabled = on),
      visible: () => this.parksEnabled,
    },
    {
      id: "rooftop",
      kinds: ["rooftop"],
      toggle: "#rooftop-toggle",
      set: (on) => (this.rooftopsEnabled = on),
      visible: () => this.rooftopsEnabled,
    },
    {
      id: "park_path",
      kinds: ["park_path"],
      toggle: "#park-paths-toggle",
      set: (on) => (this.parkPathsEnabled = on),
      visible: () => this.parkPathsEnabled,
    },
    {
      id: "power",
      kinds: ["power_tower", "power_wire"],
      toggle: "#power-lines-toggle",
      set: (on) => (this.powerLinesEnabled = on),
      visible: () => this.powerLinesEnabled,
    },
    {
      id: "wall",
      kinds: ["wall", "gate"],
      toggle: "#walls-toggle",
      set: (on) => (this.wallsEnabled = on),
      visible: () => this.wallsEnabled,
    },
    {
      id: "bridge",
      kinds: ["bridge", "tunnel"],
      toggle: "#bridges-toggle",
      set: (on) => (this.bridgesEnabled = on),
      visible: () => this.bridgesEnabled,
    },
    {
      id: "transit",
      kinds: ["transit_stop", "metro_sign", "platform", "rail"],
      toggle: "#transit-toggle",
      set: (on) => (this.transitEnabled = on),
      visible: () => this.transitEnabled,
    },
    {
      id: "sidewalk",
      kinds: ["sidewalk"],
      toggle: "#sidewalks-toggle",
      set: (on) => (this.sidewalksEnabled = on),
      visible: () =>
        this.sidewalksEnabled && this.map.getZoom() >= SIDEWALK_MIN_ZOOM,
    },
    {
      id: "lane",
      kinds: ["lane"],
      toggle: "#lanes-toggle",
      set: (on) => (this.lanesEnabled = on),
      // paint is noise at city scale: it appears with the sidewalks
      visible: () => this.lanesEnabled && this.map.getZoom() >= LANE_MIN_ZOOM,
    },
    {
      id: "fence",
      kinds: ["fence"],
      toggle: "#fences-toggle",
      set: (on) => (this.fencesEnabled = on),
      // the geometry is in the tile either way (it is cheap), only the drawing
      // waits for the zoom
      visible: () => this.fencesEnabled && this.map.getZoom() >= FENCE_MIN_ZOOM,
    },
    {
      id: "airplanes",
      kinds: ["aeroway"],
      toggle: "#airplanes-toggle",
      set: (on) => (this.airplanesEnabled = on),
      visible: () => this.airplanesEnabled,
      after: () => this.airplanes?.setEnabled(this.airplanesEnabled),
    },
  ];

  // kind -> layer, so a visibility pass is one map lookup per mesh rather than
  // a scan of every switch
  private kindToLayer?: Map<string, LayerSwitch>;

  private layerForKind(): Map<string, LayerSwitch> {
    if (!this.kindToLayer) {
      this.kindToLayer = new Map();
      for (const layer of this.layerSwitches) {
        for (const kind of layer.kinds) this.kindToLayer.set(kind, layer);
      }
    }
    return this.kindToLayer;
  }

  // re-apply one layer after its checkbox changed
  private applyLayer(id: string) {
    const layer = this.layerSwitches.find((candidate) => candidate.id === id);
    if (!layer) return;
    const on = layer.visible();
    this.loader.forEachMesh((mesh) => {
      if (layer.kinds.includes(mesh.userData.kind as string)) {
        mesh.visible = on;
      }
    });
    layer.after?.();
  }

  // re-apply every one of them; also the pass that runs after a tile loads, so
  // a tile arriving late picks up the current switches
  private applyTileVisibility() {
    const index = this.layerForKind();
    const on = new Map<LayerSwitch, boolean>();
    for (const layer of this.layerSwitches) on.set(layer, layer.visible());
    this.loader.forEachMesh((mesh) => {
      const layer = index.get(mesh.userData.kind as string);
      if (layer) mesh.visible = on.get(layer) ?? false;
    });
    for (const layer of this.layerSwitches) layer.after?.();
  }

  private disposeDetail(detail: TileRecord["detail"]): void {
    disposeFacadeDetail(this.customLayer.scene, detail);
  }

  // drop the facade detail of every tile but keep the tiles themselves
  private clearBuildingDetail() {
    for (const record of this.tiles.values()) {
      this.disposeDetail(record.detail);
      record.detail = undefined;
    }
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
    const loops = this.loader
      .allObjects()
      .flatMap((objects) => objects.traffic);
    const crossings = this.loader
      .allObjects()
      .flatMap((objects) => objects.crossings);
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
    // a runway or an apron spanning tiles repeats in each of them, so dedupe
    // by OSM id before handing them to the layer
    const runwaysById = new Map<string, RunwayLine>();
    const apronsById = new Map<string, ApronRing>();
    for (const { objects } of this.tiles.values()) {
      for (const runway of objects.runways) {
        if (!runwaysById.has(runway.id)) runwaysById.set(runway.id, runway);
      }
      for (const apron of objects.aprons) {
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
        const spots = this.tiles.get(key)?.objects.parking;
        if (spots) tiles.push({ key, spots });
      }
    }
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = scaleFactorAt(this.tileCenter[1]);
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
        const lamps = this.tiles.get(key)?.objects.lamps ?? [];
        const signals = this.tiles.get(key)?.objects.signals ?? [];
        if (lamps.length > 0 || signals.length > 0) {
          // the raw per-tile arrays are the identity the layer diffs on, so do
          // not copy them here
          tiles.push({ key, lamps, signals });
        }
      }
    }
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = scaleFactorAt(this.tileCenter[1]);
    this.nightLights.setTiles(tiles, originMeters, scaleFactor);
    this.applyNightLightsVisibility();
  }

  private applyNightLightsVisibility() {
    this.nightLights?.setLampsEnabled(this.lamppostsEnabled);
    this.nightLights?.setVisible(this.light.night, this.map.getZoom());
  }

  private recordFrame(now: number) {
    this.perf.recordFrame(now);
  }

  private reportPerf(extra: Record<string, unknown> = {}) {
    this.perf.report(extra);
  }

  // read-only counters for the perf benchmark (perf/frame_times.spec.ts); the
  // app itself never calls this
  stats(): SceneStats {
    return sceneStats(this.tiles, {
      cars: this.carsTraffic,
      trains: this.trainsTraffic,
      buses: this.busesTraffic,
      trams: this.tramsTraffic,
      parkedCars: this.parkedCars,
      nightLights: this.nightLights,
      drawCalls: this.lastSceneDraw.calls,
      triangles: this.lastSceneDraw.triangles,
    });
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
