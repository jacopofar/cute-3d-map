import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../projection";
import { platform, platformInfo } from "./platform";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(id = "way/1"): Geojson.Feature {
  return {
    type: "Feature",
    id,
    properties: { cmtype: "platform", name: "Binario 1" },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [9.189, 45.459],
          [9.191, 45.459],
          [9.191, 45.461],
          [9.189, 45.461],
          [9.189, 45.459],
        ],
      ],
    },
  };
}

describe("platform", () => {
  it("builds a raised slab with a white edge", () => {
    const built = platform(ORIGIN_METERS, SCALE, feature());
    expect(built.length).toBe(2);
    for (const geometry of built) {
      const count = geometry.getAttribute("position").count;
      expect(count).toBeGreaterThan(0);
      for (const name of ["normal", "uv", "color"]) {
        expect(geometry.getAttribute(name).count).toBe(count);
      }
    }
    built[0].computeBoundingBox();
    expect(built[0].boundingBox!.max.z).toBeCloseTo(0.28, 2);
  });

  it("keeps the name and rings for the popup", () => {
    const info = platformInfo(feature());
    expect(info?.name).toBe("Binario 1");
    expect(info?.rings[0].length).toBe(5);
    expect(info?.lon).toBeCloseTo(9.1898, 3);
  });
});
