import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
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
  it("builds a basin with a water surface and a jet", () => {
    const built = fountain(ORIGIN_METERS, SCALE, feature(3));
    expect(built).toHaveLength(1);
    const geometry = built[0];
    const position = geometry.getAttribute("position");
    expect(position.count).toBeGreaterThan(0);
    for (const name of ["normal", "uv", "color"]) {
      expect(geometry.getAttribute(name)?.count).toBe(position.count);
    }
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    // a 3 m basin, with the pedestal and jet above the water
    expect(box.max.x - box.min.x).toBeCloseTo(3, 0);
    expect(box.max.z).toBeGreaterThan(1);
    expect(box.min.z).toBeGreaterThanOrEqual(0);
  });

  it("clamps an oversized mapped area and a tiny node", () => {
    const huge = fountain(ORIGIN_METERS, SCALE, feature(100))[0];
    huge.computeBoundingBox();
    const hugeBox = huge.boundingBox!;
    expect(hugeBox.max.x - hugeBox.min.x).toBeCloseTo(FOUNTAIN_MAX_SIZE, 0);

    const tiny = fountain(ORIGIN_METERS, SCALE, feature(0.1))[0];
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
