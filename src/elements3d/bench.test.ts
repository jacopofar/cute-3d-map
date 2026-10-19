import * as THREE from "three";
import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { bench, benchFacing } from "./bench";

const ORIGIN: [number, number] = [9.18, 45.5];
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);

function benchFeature(direction?: number, id = "node/1"): Geojson.Feature {
  const properties: Record<string, unknown> = { cmtype: "bench" };
  if (direction !== undefined) properties.direction = direction;
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [ORIGIN[0], ORIGIN[1]] },
    properties,
  } as unknown as Geojson.Feature;
}

function bbox(f: Geojson.Feature): THREE.Box3 {
  const [geometry] = bench(ORIGIN_METERS, SCALE, f);
  geometry.computeBoundingBox();
  return geometry.boundingBox as THREE.Box3;
}

describe("benchFacing", () => {
  it("uses the OSM direction, in radians", () => {
    expect(benchFacing(benchFeature(0))).toBeCloseTo(0);
    expect(benchFacing(benchFeature(90))).toBeCloseTo(Math.PI / 2);
    expect(benchFacing(benchFeature(270))).toBeCloseTo((3 * Math.PI) / 2);
  });

  it("derives a stable facing from the id when there is none", () => {
    const first = benchFacing(benchFeature(undefined, "node/42"));
    // stable across calls (a rebuild must not shuffle the benches)
    expect(benchFacing(benchFeature(undefined, "node/42"))).toBe(first);
    // and different ids generally differ
    expect(benchFacing(benchFeature(undefined, "node/43"))).not.toBe(first);
  });
});

describe("bench", () => {
  it("merges every part into one geometry with the tree attribute set", () => {
    const parts = bench(ORIGIN_METERS, SCALE, benchFeature(0));
    expect(parts).toHaveLength(1);
    const attributes = Object.keys(parts[0].attributes).sort();
    expect(attributes).toEqual(["color", "normal", "position", "uv"]);
  });

  it("is roughly a 1.6 x 0.5 m bench, up to 0.85 m", () => {
    const box = bbox(benchFeature(0));
    const size = box.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(1.6, 1);
    expect(size.y).toBeCloseTo(0.5, 1);
    expect(box.min.z).toBeCloseTo(0, 1);
    expect(box.max.z).toBeCloseTo(0.85, 1);
  });

  it("turns the facing direction: an east-facing bench is deep along Y", () => {
    const box = bbox(benchFeature(90));
    const size = box.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(0.5, 1);
    expect(size.y).toBeCloseTo(1.6, 1);
  });
});
