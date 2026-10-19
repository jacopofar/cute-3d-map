import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "./geojson_data";
import { PlaneLayer, PLANE_MIN_ZOOM } from "./airplanes";

// Linate's 17/35 runway, ~1600 m
const RUNWAY = {
  id: "way/1",
  coords: [
    [9.2758874, 45.4561712],
    [9.277427, 45.4418079],
  ] as [number, number][],
  width: 60,
};

const ORIGIN: [number, number] = [9.2767, 45.4494];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function airplaneMesh(scene: THREE.Scene): THREE.InstancedMesh {
  const found = scene.children.find(
    (object) => object.userData?.kind === "airplane",
  );
  if (!found) throw new Error("no airplane mesh in the scene");
  return found as THREE.InstancedMesh;
}

// the uniform scale baked into an instance matrix (0 when hidden)
function instanceScale(mesh: THREE.InstancedMesh, slot: number): number {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(slot, m);
  const e = m.elements;
  return Math.hypot(e[0], e[1], e[2]);
}

describe("PlaneLayer", () => {
  it("is visible now and then, not constantly", () => {
    const scene = new THREE.Scene();
    const layer = new PlaneLayer(scene);
    layer.setRunways([RUNWAY]);
    const mesh = airplaneMesh(scene);

    let visible = 0;
    let hidden = 0;
    for (let t = 0; t < 900; t += 0.5) {
      layer.update(ORIGIN_METERS, SCALE, { zoom: 17, now: t * 1000 });
      expect(mesh.count).toBe(1);
      if (instanceScale(mesh, 0) > 0) visible++;
      else hidden++;
    }
    // a flight is drawn part of the time ...
    expect(visible).toBeGreaterThan(0);
    // ... and the runway is quiet otherwise
    expect(hidden).toBeGreaterThan(0);
    expect(visible).toBeLessThan(hidden);
  });

  it("hides the whole layer below the plane zoom gate", () => {
    const scene = new THREE.Scene();
    const layer = new PlaneLayer(scene);
    layer.setRunways([RUNWAY]);
    const mesh = airplaneMesh(scene);

    layer.update(ORIGIN_METERS, SCALE, {
      zoom: PLANE_MIN_ZOOM - 1,
      now: 12_345,
    });
    expect(mesh.visible).toBe(false);

    layer.update(ORIGIN_METERS, SCALE, { zoom: PLANE_MIN_ZOOM, now: 12_345 });
    expect(mesh.visible).toBe(true);
  });

  it("is switched off by setEnabled", () => {
    const scene = new THREE.Scene();
    const layer = new PlaneLayer(scene);
    layer.setRunways([RUNWAY]);
    const mesh = airplaneMesh(scene);
    layer.setEnabled(false);
    layer.update(ORIGIN_METERS, SCALE, { zoom: 18, now: 12_345 });
    expect(mesh.visible).toBe(false);
  });

  it("builds the whole airliner, not just one part", () => {
    const scene = new THREE.Scene();
    new PlaneLayer(scene);
    const mesh = airplaneMesh(scene);
    // a single box would be 36 non-indexed vertices; the merged airliner is
    // many more (the merge silently falls back to one part if the attributes
    // do not agree)
    expect(mesh.geometry.getAttribute("position").count).toBeGreaterThan(200);
  });
});
