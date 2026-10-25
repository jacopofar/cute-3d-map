import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../projection";
import { FOUNTAIN_MAX_SIZE, FOUNTAIN_MIN_SIZE, fountain } from "./fountain";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(size: number, id = "way/1"): Geojson.Feature {
  return {
    type: "Feature",
    id,
    properties: { cmtype: "fountain", size },
    geometry: { type: "Point", coordinates: [9.19, 45.46] },
  };
}

describe("fountain", () => {
  it("splits the basin into a stone mesh and an animated water mesh", () => {
    const { stone, water } = fountain(ORIGIN_METERS, SCALE, feature(3));
    expect(stone).toHaveLength(1);
    expect(water).toHaveLength(1);
    for (const geometry of [...stone, ...water]) {
      const position = geometry.getAttribute("position");
      expect(position.count).toBeGreaterThan(0);
      for (const name of ["normal", "uv", "color"]) {
        expect(geometry.getAttribute(name)?.count).toBe(position.count);
      }
    }
    stone[0].computeBoundingBox();
    const stoneBox = stone[0].boundingBox!;
    expect(stoneBox.max.x - stoneBox.min.x).toBeCloseTo(3, 0);
    water[0].computeBoundingBox();
    const waterBox = water[0].boundingBox!;
    // the bowl and jet rise above the basin
    expect(waterBox.max.z).toBeGreaterThan(1);
    expect(waterBox.min.z).toBeGreaterThanOrEqual(0);
  });

  it("clamps an oversized mapped area and a tiny node", () => {
    const huge = fountain(ORIGIN_METERS, SCALE, feature(100)).stone[0];
    huge.computeBoundingBox();
    const hugeBox = huge.boundingBox!;
    expect(hugeBox.max.x - hugeBox.min.x).toBeCloseTo(FOUNTAIN_MAX_SIZE, 0);

    const tiny = fountain(ORIGIN_METERS, SCALE, feature(0.1)).stone[0];
    tiny.computeBoundingBox();
    const tinyBox = tiny.boundingBox!;
    expect(tinyBox.max.x - tinyBox.min.x).toBeCloseTo(FOUNTAIN_MIN_SIZE, 0);
  });

  it("rejects a non-point", () => {
    const line: Geojson.Feature = {
      type: "Feature",
      id: "way/2",
      properties: { cmtype: "fountain", size: 2 },
      geometry: {
        type: "LineString",
        coordinates: [
          [9.19, 45.46],
          [9.2, 45.46],
        ],
      },
    };
    expect(() => fountain(ORIGIN_METERS, SCALE, line)).toThrow();
  });
});
