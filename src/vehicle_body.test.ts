import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { CAR_TRAFFIC, TRAIN_TRAFFIC } from "./traffic";
import { vehicleGeometry, type VehicleBodySize } from "./vehicle_body";

const EPS = 1e-6;

function triangles(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute("position");
  return position.count / 3;
}

function bounds(geometry: THREE.BufferGeometry): THREE.Box3 {
  geometry.computeBoundingBox();
  return geometry.boundingBox!;
}

function expectWithin(
  geometry: THREE.BufferGeometry,
  size: VehicleBodySize,
): void {
  const box = bounds(geometry);
  expect(box.min.x).toBeGreaterThanOrEqual(-size.length / 2 - EPS);
  expect(box.max.x).toBeLessThanOrEqual(size.length / 2 + EPS);
  expect(box.min.y).toBeGreaterThanOrEqual(-size.width / 2 - EPS);
  expect(box.max.y).toBeLessThanOrEqual(size.width / 2 + EPS);
  expect(box.min.z).toBeGreaterThanOrEqual(-size.height / 2 - EPS);
  expect(box.max.z).toBeLessThanOrEqual(size.height / 2 + EPS);
}

function vertices(geometry: THREE.BufferGeometry): THREE.Vector3[] {
  const position = geometry.getAttribute("position");
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < position.count; i++) {
    out.push(
      new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i)),
    );
  }
  return out;
}

describe("vehicleGeometry", () => {
  it("keeps the car within the fleet's box and its triangle budget", () => {
    const geometry = vehicleGeometry(CAR_TRAFFIC);
    // a box is 12 triangles, and every one is multiplied by ~70k parked cars
    expect(triangles(geometry)).toBe(52);
    expectWithin(geometry, CAR_TRAFFIC);
    // the wheels are the lowest part, exactly on the ground under the
    // renderer's height / 2 placement
    expect(bounds(geometry).min.z).toBeCloseTo(-CAR_TRAFFIC.height / 2, 6);
  });

  it("tucks four wheels below the chassis", () => {
    const geometry = vehicleGeometry(CAR_TRAFFIC);
    const floor = -CAR_TRAFFIC.height / 2 + 0.18 * CAR_TRAFFIC.height;
    const low = vertices(geometry).filter((v) => v.z < floor - 1e-4);
    expect(low.length).toBeGreaterThan(0);
    // at least one wheel vertex in each quadrant, so all four wheels are under
    // the body rather than stacked on one side
    const quadrants = new Set(
      low.map((v) => `${Math.sign(v.x)}:${Math.sign(v.y)}`),
    );
    expect(quadrants).toEqual(new Set(["-1:-1", "1:-1", "1:1", "-1:1"]));
  });

  it("gives the car a paint-ready body and a dark cabin", () => {
    const geometry = vehicleGeometry(CAR_TRAFFIC);
    const color = geometry.getAttribute("color");
    expect(color.count).toBe(geometry.getAttribute("position").count);
    let lightest = 0;
    let darkest = 1;
    for (let i = 0; i < color.count; i++) {
      lightest = Math.max(lightest, color.getX(i));
      darkest = Math.min(darkest, color.getX(i));
    }
    // the paint multiplies the vertex color, so the chassis is near white and
    // the glass/wheels are very dark
    expect(lightest).toBeGreaterThan(0.8);
    expect(darkest).toBeLessThan(0.02);
  });

  it("keeps a long windowed box for trains", () => {
    const geometry = vehicleGeometry(TRAIN_TRAFFIC);
    expect(triangles(geometry)).toBeLessThan(60);
    expectWithin(geometry, TRAIN_TRAFFIC);
    // no car wheels on a 15 m train: the body starts at the ground itself
    expect(bounds(geometry).min.z).toBeCloseTo(-TRAIN_TRAFFIC.height / 2, 6);
  });
});
