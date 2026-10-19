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

  it("a takeoff climbs out without reversing or shrinking in mid-air", () => {
    const scene = new THREE.Scene();
    const layer = new PlaneLayer(scene);
    // a straight north-south runway, so the model y is the along-runway axis
    layer.setRunways([
      {
        id: "way/2",
        coords: [
          [9.27, 45.44],
          [9.27, 45.45],
        ],
        width: 45,
      },
    ]);
    const mesh = airplaneMesh(scene);
    const matrix = new THREE.Matrix4();
    const columns: { y: number; z: number; scale: number }[] = [];
    const spans: { y: number; z: number; scale: number }[][] = [];
    for (let t = 0; t < 400; t += 0.1) {
      layer.update(ORIGIN_METERS, SCALE, { zoom: 17, now: t * 1000 });
      mesh.getMatrixAt(0, matrix);
      const e = matrix.elements;
      const scale = Math.hypot(e[0], e[1], e[2]);
      if (scale <= 0) {
        if (columns.length > 0) spans.push(columns.splice(0));
        continue;
      }
      columns.push({ y: e[13], z: e[14], scale });
    }
    if (columns.length > 0) spans.push(columns);

    expect(spans.length).toBeGreaterThan(0);
    let climbedHigh = false;
    for (const span of spans) {
      // a flight never turns back on itself: the old bug bounced it off the
      // end of the runway by extrapolating the wrong way
      const direction = Math.sign(span[span.length - 1].y - span[0].y);
      for (let i = 1; i < span.length; i++) {
        if (direction >= 0) {
          expect(span[i].y).toBeGreaterThanOrEqual(span[i - 1].y - 1e-6);
        } else {
          expect(span[i].y).toBeLessThanOrEqual(span[i - 1].y + 1e-6);
        }
      }
      // and it is never shrunk to hide it: it climbs and the schedule drops it
      for (const sample of span) {
        if (sample.z > 5) expect(sample.scale).toBeCloseTo(1, 6);
        if (sample.z > 300) climbedHigh = true;
      }
    }
    expect(climbedHigh).toBe(true);
  });

  it("parks static airliners on an apron", () => {
    const scene = new THREE.Scene();
    const layer = new PlaneLayer(scene);
    const mesh = airplaneMesh(scene);
    layer.setAprons([
      [
        [9.27, 45.44],
        [9.3, 45.44],
        [9.3, 45.445],
        [9.27, 45.445],
        [9.27, 45.44],
      ],
    ]);
    layer.update(ORIGIN_METERS, SCALE, { zoom: 17, now: 0 });
    expect(mesh.count).toBeGreaterThanOrEqual(1);
    const first = new THREE.Matrix4();
    mesh.getMatrixAt(0, first);
    // the parked planes do not move with the clock
    layer.update(ORIGIN_METERS, SCALE, { zoom: 17, now: 5000 });
    const later = new THREE.Matrix4();
    mesh.getMatrixAt(0, later);
    expect(first.equals(later)).toBe(true);
  });
});
