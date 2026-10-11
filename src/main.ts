import {
  Map as MapLibreMap,
  MercatorCoordinate,
  ScaleControl,
} from "maplibre-gl";
import * as THREE from "three";
import "./maplibre_setup";

import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
// import {VRButton} from 'three/addons/webxr/VRButton.js';

import type { CustomLayerInterface, LngLat } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { objectsAt, TILE_ZOOM } from "./geojson_data.ts";

import "./style.css";
// Import our custom CSS
// import "./scss/styles.scss";

import "./map_style.css";

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
  // tiles with a fetch in flight; kept separate from loadedTiles so a failed
  // load does not leave a permanent "loaded but empty" entry that blocks retries
  private pendingTiles: Set<string> = new Set();
  private renderTileMargin: number = 3;
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
      zoom: 14,
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
        // create two three.js lights to illuminate the model
        const directionalLight = new THREE.DirectionalLight(0xffffff);
        directionalLight.position.set(0, -70, 100).normalize();
        this.scene.add(directionalLight);

        const directionalLight2 = new THREE.DirectionalLight(0xffffff);
        directionalLight2.position.set(0, 70, 100).normalize();
        this.scene.add(directionalLight2);

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

        this.renderer.autoClear = false;
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
      const center = this.map.getCenter();
      this.loadUnloadCoord(center);
    });
  }

  private resetOrigin(center: LngLat) {
    const origin = MercatorCoordinate.fromLngLat(center, 0);
    this.modelTransform = {
      translateX: origin.x,
      translateY: origin.y,
      translateZ: origin.z,
      rotateX: 0,
      rotateY: 0,
      rotateZ: 0,
      scale: origin.meterInMercatorCoordinateUnits(),
    };
    // mesh geometry is built in meters relative to the projection origin, so
    // every loaded tile is now in a coordinate space that no longer matches
    // the transform: drop all of them, they get recomputed against the new
    // origin by the load loop that follows
    Object.values(this.loadedTiles)
      .flat()
      .forEach((m) => this.customLayer.scene.remove(m));
    this.loadedTiles = {};
    this.tileCenter = [center.lng, center.lat];
    // bump the generation so async tile loads started with the previous
    // origin can be discarded instead of landing on the new projection
    this.originGeneration += 1;
    // in-flight loads belong to the old generation and will be discarded when
    // they resolve, so clear their bookkeeping to let the new load loop
    // request those tiles again
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
    console.log("center tile:", cx, cy);
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
        this.loadedTiles[k].forEach((m) => this.customLayer.scene.remove(m));
        deleteUsKeys.push(k);
      }
    });
    deleteUsKeys.forEach((k) => delete this.loadedTiles[k]);
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
      const meshes = await objectsAt(this.tileCenter, x, y);
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
    } catch (e) {
      // leave the tile out of loadedTiles so a later move retries it
      console.warn("failed to load tile", tileKey, e);
    } finally {
      this.pendingTiles.delete(tileKey);
    }
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

const c = new CoolMap([9.186, 45.497]);
// example of how to download GLTF file
// setTimeout(async () => {
//   const data = await c.getGLTF();
//   const blob = new Blob([data], { type: "model/gltf-binary" });
//   const link = document.createElement("a");
//   link.href = window.URL.createObjectURL(blob);
//   link.download = "gltf.glb";
//   link.click();
// }, 5000);
