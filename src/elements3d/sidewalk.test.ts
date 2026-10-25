import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../projection";
import { sidewalk } from "./sidewalk";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(): Geojson.Feature {
  return {
    type: "Feature",
    id: "sidewalk/1/2",
    properties: { cmtype: "sidewalk" },
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

describe("sidewalk", () => {
  it("extrudes the polygon to the slab height", () => {
    const built = sidewalk(ORIGIN_METERS, SCALE, feature());
    expect(built).toHaveLength(1);
    const geometry = built[0];
    const count = geometry.getAttribute("position").count;
    expect(count).toBeGreaterThan(0);
    for (const name of ["normal", "uv", "color"]) {
      expect(geometry.getAttribute(name).count).toBe(count);
    }
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.z).toBeCloseTo(0, 5);
    expect(geometry.boundingBox!.max.z).toBeCloseTo(0.14, 2);
  });

  it("returns nothing for a line", () => {
    const f = feature();
    f.geometry = {
      type: "LineString",
      coordinates: [
        [9.189, 45.459],
        [9.191, 45.461],
      ],
    };
    expect(sidewalk(ORIGIN_METERS, SCALE, f)).toEqual([]);
  });
});
