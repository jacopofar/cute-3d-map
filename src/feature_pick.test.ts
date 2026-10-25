import { describe, expect, it } from "vitest";

import type { BarrierInfo, FeatureInfo } from "./geojson_data";
import { toModelCoords } from "./projection";
import {
  barrierAt,
  featureAt,
  ringContains,
  ringDistance,
} from "./feature_pick";

// the origin and scale cancel out in these tests: model coordinates are just a
// local meter plane, with 0.001 deg of longitude about 111 m at the equator
const ORIGIN: [number, number] = [0, 0];
const SCALE = 1;
const at = (lon: number, lat: number) => {
  const [x, y] = toModelCoords([lon, lat], ORIGIN, SCALE);
  return { x, y };
};

const square = [
  [0, 0],
  [0.001, 0],
  [0.001, 0.001],
  [0, 0.001],
] as [number, number][];

describe("feature picking", () => {
  it("contains points in a ring and measures distances to its edges", () => {
    expect(ringContains(square, at(0.0005, 0.0005), ORIGIN, SCALE)).toBe(true);
    expect(ringContains(square, at(0.002, 0.0005), ORIGIN, SCALE)).toBe(false);

    const distance = ringDistance(square, at(0.0015, 0.0005), ORIGIN, SCALE);
    // 0.0005 deg east of the right edge, about 55.7 m
    expect(distance).toBeGreaterThan(54);
    expect(distance).toBeLessThan(57);
  });

  it("picks the nearest point feature within the limit", () => {
    const tree: FeatureInfo = { kind: "tree", lon: 0.001, lat: 0 };
    expect(
      featureAt([tree], ["tree"], at(0.001, 0.00002), ORIGIN, SCALE, 5),
    ).toBe(tree);
    expect(
      featureAt([tree], ["tree"], at(0.002, 0), ORIGIN, SCALE, 5),
    ).toBeUndefined();

    const near: FeatureInfo = { kind: "tree", lon: 0.0011, lat: 0 };
    expect(
      featureAt([tree, near], ["tree"], at(0.0011, 0), ORIGIN, SCALE, 20),
    ).toBe(near);
  });

  it("picks a line feature by its distance", () => {
    const rail: FeatureInfo = {
      kind: "rail",
      lines: [
        [
          [0, 0],
          [0.001, 0],
        ],
      ],
    };
    expect(
      featureAt([rail], ["rail"], at(0.0005, 0.00004), ORIGIN, SCALE, 5),
    ).toBe(rail);
    expect(
      featureAt([rail], ["rail"], at(0.0005, 0.0001), ORIGIN, SCALE, 5),
    ).toBeUndefined();
  });

  it("picks an area by containment, then by a near miss", () => {
    const park: FeatureInfo = { kind: "green", rings: [square] };
    expect(
      featureAt([park], ["green"], at(0.0005, 0.0005), ORIGIN, SCALE, 1),
    ).toBe(park);
    expect(
      featureAt([park], ["green"], at(0.0012, 0.0005), ORIGIN, SCALE, 25),
    ).toBe(park);
    expect(
      featureAt([park], ["green"], at(0.002, 0.0005), ORIGIN, SCALE, 1),
    ).toBeUndefined();
  });

  it("filters by kind and keeps the nearest candidate", () => {
    const row: FeatureInfo = {
      kind: "tree_row",
      lines: [
        [
          [0, 0],
          [0.001, 0],
        ],
      ],
    };
    expect(
      featureAt([row], ["tree"], at(0.0005, 0), ORIGIN, SCALE, 5),
    ).toBeUndefined();
    expect(
      featureAt([row], ["tree", "tree_row"], at(0.0005, 0), ORIGIN, SCALE, 5),
    ).toBe(row);
  });

  it("picks the nearest fence or wall line", () => {
    const fence: BarrierInfo = {
      kind: "fence",
      coords: [
        [0, 0],
        [0.001, 0],
      ],
      bbox: [0, 0, 0.001, 0],
    };
    expect(barrierAt([fence], at(0.0005, 0.00004), ORIGIN, SCALE, 5)).toBe(
      fence,
    );
    expect(
      barrierAt([fence], at(0.0005, 0.0002), ORIGIN, SCALE, 5),
    ).toBeUndefined();
  });
});
