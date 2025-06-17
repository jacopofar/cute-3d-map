import { Map as MapLibreMap, MercatorCoordinate, ScaleControl} from "maplibre-gl";
import type {CustomLayerInterface} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import * as THREE from 'three';

import {meshesAt} from "./geojson_data.ts";


import "./style.css";
// Import our custom CSS
// import "./scss/styles.scss";

import "./map_style.css";

const tileCenter: [number, number] = [9.196262, 45.497];

const map = new MapLibreMap({
  container: "central-map",
  center: tileCenter,
  zoom: 16,
  pitch: 30,
  style: `https://api.maptiler.com/maps/basic-v2/style.json?key=${import.meta.env.VITE_MAPTILER_KEY}`,
});

let scale = new ScaleControl({
    maxWidth: 80,
    unit: 'metric'
});
map.addControl(scale);


// parameters to ensure the model is georeferenced correctly on the map
const modelOrigin = tileCenter;
const modelAltitude = 0;
const modelRotate = [0, 0, 0];

const modelAsMercatorCoordinate = MercatorCoordinate.fromLngLat(
    modelOrigin,
    modelAltitude
);
console.log("MERCATOR: ", modelAsMercatorCoordinate, modelAsMercatorCoordinate.toLngLat())

// transformation parameters to position, rotate and scale the 3D model onto the map
const modelTransform = {
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
    scale: modelAsMercatorCoordinate.meterInMercatorCoordinateUnits()
};

interface ThreeJSLayerInterface extends CustomLayerInterface {
    camera: THREE.Camera;
    scene: THREE.Scene;
    renderer?: THREE.WebGLRenderer;
    map: MapLibreMap;
}

// configuration of the custom layer for a 3D model per the CustomLayerInterface
const customLayer: ThreeJSLayerInterface = {
    id: '3d-model',
    type: 'custom',
    renderingMode: '3d',
    map: map,
    camera: new THREE.PerspectiveCamera(),
    scene:  new THREE.Scene(),
    onAdd(map, gl) {
        // create two three.js lights to illuminate the model
        const directionalLight = new THREE.DirectionalLight(0xffffff);
        directionalLight.position.set(0, -70, 100).normalize();
        this.scene.add(directionalLight);

        const directionalLight2 = new THREE.DirectionalLight(0xffffff);
        directionalLight2.position.set(0, 70, 100).normalize();
        this.scene.add(directionalLight2);

        // add a cube with side 100m as a reference to check that the scale is right
        const geometry = new THREE.BoxGeometry( 100, 100, 100 );
        // const material = new THREE.MeshToonMaterial( {color: 0x00ff00} );
        const material = new THREE.MeshStandardMaterial({
            color: 0x10ff10,
            transparent: true,
            opacity: 0.5
            // wireframe: true
        });
        const cube = new THREE.Mesh(geometry, material );
        cube.translateZ(50);
        this.scene.add(cube);

        // this.scene.add(heartMesh());
        meshesAt(tileCenter, modelAsMercatorCoordinate.meterInMercatorCoordinateUnits()).forEach(m => this.scene.add(m));
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
            antialias: true
        });

        this.renderer.autoClear = false;
    },
    render (gl, args) {
        const rotationX = new THREE.Matrix4().makeRotationAxis(
            new THREE.Vector3(1, 0, 0),
            modelTransform.rotateX
        );
        const rotationY = new THREE.Matrix4().makeRotationAxis(
            new THREE.Vector3(0, 1, 0),
            modelTransform.rotateY
        );
        const rotationZ = new THREE.Matrix4().makeRotationAxis(
            new THREE.Vector3(0, 0, 1),
            modelTransform.rotateZ
        );

        const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix);
        const l = new THREE.Matrix4()
            .makeTranslation(
                modelTransform.translateX,
                modelTransform.translateY,
                modelTransform.translateZ
            )
            .scale(
                new THREE.Vector3(
                    modelTransform.scale,
                    -modelTransform.scale,
                    modelTransform.scale
                )
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
        if(this.renderer){
            this.renderer.resetState();
            this.renderer.render(this.scene, this.camera);
        }
        else{
            // this.renderer is set up on onAdd, so it should always be present
            // but typescript does not know that
            throw Error("render called when renderer is missing!!")
        }
        this.map.triggerRepaint();
    }
};

map.on('style.load', () => {
    map.addLayer(customLayer);
});