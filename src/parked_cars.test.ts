import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "./geojson_data";
import { PARKED_CAR_MIN_ZOOM, ParkedCarLayer } from "./parked_cars";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function layerMesh(scene: THREE.Scene): THREE.InstancedMesh {
  const found = scene.children.find(
    (object) => object.userData?.kind === "parked_car",
  );
  if (!found) throw new Error("no parked-car mesh in the scene");
  return found as THREE.InstancedMesh;
}

describe("ParkedCarLayer", () => {
  it("places one static instance per spot", () => {
    const scene = new THREE.Scene();
    const layer = new ParkedCarLayer(scene, 10);
    layer.setSpots(
      [
        { lon: 9.19, lat: 45.46, heading: 0 },
        { lon: 9.191, lat: 45.46, heading: Math.PI / 2 },
      ],
      ORIGIN_METERS,
      SCALE,
    );
    expect(layer.count).toBe(2);
    const mesh = layerMesh(scene);
    expect(mesh.count).toBe(2);
    const first = new THREE.Matrix4();
    mesh.getMatrixAt(0, first);
    // the first spot is the origin itself
    expect(first.elements[12]).toBeCloseTo(0, 4);
    expect(first.elements[13]).toBeCloseTo(0, 4);
    // and sits on the ground with the car body's half height
    expect(first.elements[14]).toBeCloseTo(0.5, 4);
  });

  it("truncates to its instance capacity", () => {
    const scene = new THREE.Scene();
    const layer = new ParkedCarLayer(scene, 2);
    layer.setSpots(
      [
        { lon: 9.19, lat: 45.46, heading: 0 },
        { lon: 9.191, lat: 45.46, heading: 0 },
        { lon: 9.192, lat: 45.46, heading: 0 },
      ],
      ORIGIN_METERS,
      SCALE,
    );
    expect(layer.count).toBe(2);
    expect(layerMesh(scene).count).toBe(2);
  });

  it("is hidden by setEnabled(false)", () => {
    const scene = new THREE.Scene();
    const layer = new ParkedCarLayer(scene, 4);
    layer.setSpots([], ORIGIN_METERS, SCALE);
    layer.setEnabled(false);
    expect(layerMesh(scene).visible).toBe(false);
    layer.setEnabled(true);
    expect(layerMesh(scene).visible).toBe(true);
  });

  it("uses the same zoom gate as the building windows", () => {
    expect(PARKED_CAR_MIN_ZOOM).toBe(17);
  });
});
