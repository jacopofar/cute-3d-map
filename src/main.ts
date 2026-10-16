import {
  Map as MapLibreMap,
  MercatorCoordinate,
  Popup,
  ScaleControl,
} from "maplibre-gl";
import * as THREE from "three";
import "./maplibre_setup";

import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
// import {VRButton} from 'three/addons/webxr/VRButton.js';

import type { CustomLayerInterface, LngLat } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import {
  objectsAt,
  TILE_ZOOM,
  epsg4326toEpsg3857,
  toModelCoords,
} from "./geojson_data.ts";
import type { BuildingInfo, TrafficLoop } from "./geojson_data.ts";
import { TrafficRenderer, CAR_TRAFFIC, TRAIN_TRAFFIC } from "./traffic.ts";
import { CloudLayer } from "./clouds.ts";

import "./style.css";
// Import our custom CSS
// import "./scss/styles.scss";

import "./map_style.css";

// precomputed vehicles are only shown when the map is at least this zoomed in
const VEHICLE_MIN_ZOOM = 15;

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

// distance (m) from a model-space point to a ring, used as a picking fallback
function ringDistance(
  ring: [number, number][],
  point: THREE.Vector3,
  originMeters: [number, number],
  scaleFactor: number,
): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = toModelCoords(ring[i], originMeters, scaleFactor);
    const b = toModelCoords(ring[j], originMeters, scaleFactor);
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

class CoolMap {
  tileCenter: [number, number];
  map: MapLibreMap;
  private customLayer: ThreeJSLayerInterface;
  private loadedTiles: { [key: string]: THREE.Object3D[] } = {};
  // precomputed loops per loaded tile
  private loadedTraffic: { [key: string]: TrafficLoop[] } = {};
  // building footprints per loaded tile, for click-picking
  private loadedBuildings: { [key: string]: BuildingInfo[] } = {};
  private highlight?: THREE.Object3D;
  private popup?: Popup;
  private carsTraffic?: TrafficRenderer;
  private trainsTraffic?: TrafficRenderer;
  // set when a tile load/unload changes the routes; applied once per frame
  private trafficDirty = false;
  private clouds?: CloudLayer;
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
  constructor(tileCenter: [number, number]) {
    this.tileCenter = tileCenter;
    this.map = new MapLibreMap({
      container: "central-map",
      center: tileCenter,
      zoom: 17,
      pitch: 30,
      style: `https://api.maptiler.com/maps/basic-v2/style.json?key=${import.meta.env.VITE_MAPTILER_KEY}`,
    });
    // for debugging
    this.map.showTileBoundaries = false;

    this.map.addControl(
      new ScaleControl({
        maxWidth: 80,
        unit: "metric",
      }),
    );
    // parameters to ensure the model is georeferenced correctly on the map
    const modelOrigin = tileCenter;
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
        // lighting: a warm sun, a cool fill from the opposite side, and a
        // hemisphere light so faces away from the sun are not pitch black
        const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
        sun.position.set(-40, 60, 100).normalize();
        this.scene.add(sun);

        const fill = new THREE.DirectionalLight(0xbfd4ff, 0.6);
        fill.position.set(60, -50, 60).normalize();
        this.scene.add(fill);

        const hemisphere = new THREE.HemisphereLight(0xcfe0ff, 0x4a4030, 1.0);
        this.scene.add(hemisphere);

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

        this.renderer.autoClear = false;
        // animated cars and trains, added to the scene directly — NOT via
        // loadedTiles — so the origin reset does not touch them; their
        // positions are recomputed each frame from the precomputed loops
        coolMap.carsTraffic = new TrafficRenderer(this.scene, CAR_TRAFFIC);
        coolMap.trainsTraffic = new TrafficRenderer(this.scene, TRAIN_TRAFFIC);
        // decorative clouds, also added directly to the scene: their positions
        // are relative to the visible area rather than to a tile
        coolMap.clouds = new CloudLayer(this.scene);
        coolMap.clouds.setEnabled(coolMap.cloudsEnabled);
        // tiles may already have loaded before this layer was added, so seed
        // the renderer with whatever routes are present
        coolMap.syncTraffic();
        // NOTE: currently broken
        // see https://github.com/potree/potree/blob/develop/src/viewer/viewer.js#L1921
        // this.renderer.xr.enabled = true;
        // document.body.appendChild(VRButton.createButton(this.renderer));
      },
      render(gl, args) {
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
        if (coolMap.trafficDirty) {
          coolMap.trafficDirty = false;
          coolMap.applyTrafficLoops();
        }
        if (coolMap.carsTraffic) {
          coolMap.carsTraffic.update(originMeters, scaleFactor);
        }
        if (coolMap.trainsTraffic) {
          coolMap.trainsTraffic.update(originMeters, scaleFactor);
        }
        coolMap.updateClouds(originMeters, scaleFactor);
        if (this.renderer) {
          this.renderer.resetState();
          this.renderer.render(this.scene, this.camera);
        } else {
          // this.renderer is set up on onAdd, so it should always be present
          // but typescript does not know that
          throw Error("render called when renderer is missing!!");
        }
        this.map.triggerRepaint();
      },
    };

    this.map.on("style.load", () => {
      this.map.addLayer(this.customLayer);
      // load map data at setup before the user moves
      this.loadUnloadCoord(this.map.getCenter());
      this.applyTrafficState();
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

    this.map.on("click", (event) => this.onMapClick(event));
  }

  // click a building to highlight it and show its height/address
  private onMapClick(event: {
    point: { x: number; y: number };
    lngLat: LngLat;
  }) {
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
    const buildingMeshes: THREE.Object3D[] = [];
    for (const meshes of Object.values(this.loadedTiles)) {
      for (const mesh of meshes) {
        if (mesh.userData.kind === "building") buildingMeshes.push(mesh);
      }
    }
    const hits = raycaster.intersectObjects(buildingMeshes, false);
    if (hits.length === 0) {
      this.clearSelection();
      return;
    }
    const hit = hits[0];
    const tileKey = hit.object.userData.tileKey as string | undefined;
    const point = hit.point;
    const originMeters = epsg4326toEpsg3857(this.tileCenter);
    const scaleFactor = Math.cos((2 * Math.PI * this.tileCenter[1]) / 360);
    const candidates = this.loadedBuildings[tileKey ?? ""] ?? [];
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
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      address ? escapeHtml(address) : null,
      `Height: ${info.height.toFixed(1)} m`,
      `<a href="#" data-zoom>Zoom to building</a>`,
    ].filter(Boolean);
    this.popup = new Popup({ closeButton: true, offset: 8 })
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
      if (this.highlight instanceof THREE.LineSegments) {
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
    // in-flight loads were baked against the old origin, so discard them and
    // clear their bookkeeping to let the load loop request them again
    this.originGeneration += 1;
    this.pendingTiles.clear();
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
          if (m instanceof THREE.Mesh) m.geometry.dispose();
        });
        delete this.loadedTraffic[k];
        delete this.loadedBuildings[k];
        deleteUsKeys.push(k);
      }
    });
    deleteUsKeys.forEach((k) => delete this.loadedTiles[k]);
    // the routes of an unloaded tile are gone; hand the renderer the remaining
    // ones. setLoops only reprepares plain data, so this is cheap enough to run
    // on the moves that actually unload a tile.
    if (deleteUsKeys.length > 0) this.syncTraffic();
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
      const { meshes, buildings, traffic } = await objectsAt(
        this.tileCenter,
        x,
        y,
      );
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
      this.syncTraffic();
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
    const on = this.trafficEnabled && this.map.getZoom() >= VEHICLE_MIN_ZOOM;
    if (on === this.carsTraffic.enabled) return;
    this.carsTraffic.setEnabled(on);
    this.trainsTraffic.setEnabled(on);
    if (on) this.syncTraffic();
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
  // split by kind. Marked dirty here and applied at most once per frame: a tile
  // burst would otherwise rebuild every car's schedule ~49 times over.
  private syncTraffic() {
    this.trafficDirty = true;
  }

  private applyTrafficLoops() {
    const loops = Object.values(this.loadedTraffic).flat();
    this.carsTraffic?.setLoops(loops.filter((loop) => loop.kind === "car"));
    this.trainsTraffic?.setLoops(loops.filter((loop) => loop.kind === "train"));
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
        if (!(object instanceof THREE.Mesh)) continue;
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
        bucket.triangles += object.geometry.index
          ? object.geometry.index.count / 3
          : count / 3;
        vertices += count;
      }
    }
    const renderInfo = this.customLayer.renderer?.info.render;
    return {
      tiles: Object.keys(this.loadedTiles).length,
      meshes,
      vertices,
      // last frame, as reported by three's renderer
      drawCalls: renderInfo?.calls ?? 0,
      triangles: renderInfo?.triangles ?? 0,
      byKind,
      buildings: Object.values(this.loadedBuildings).reduce(
        (n, b) => n + b.length,
        0,
      ),
      vehicles: this.carsTraffic?.count ?? 0,
      trains: this.trainsTraffic?.count ?? 0,
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

const c = new CoolMap([9.195070, 45.495700]);

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
