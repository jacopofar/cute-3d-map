import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { construction } from "./construction";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(crane: boolean, id = "way/1"): Geojson.Feature {
  return {
    type: "Feature",
    id,
    properties: {
      cmtype: "construction",
      crane,
      site_area: 5000,
    },
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

describe("construction", () => {
  it("builds a dirt site with a tall crane", () => {
    const built = construction(ORIGIN_METERS, SCALE, feature(true));
    expect(built).toHaveLength(1);
    const geometry = built[0];
    const position = geometry.getAttribute("position");
    expect(position.count).toBeGreaterThan(0);
    for (const name of ["normal", "uv", "color"]) {
      expect(geometry.getAttribute(name)?.count).toBe(position.count);
    }
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    // the crane mast is much taller than the dirt
    expect(box.max.z).toBeGreaterThan(20);
    expect(box.min.z).toBeGreaterThanOrEqual(0);
  });

  it("leaves a tile without the crane tile as flat dirt", () => {
    const built = construction(ORIGIN_METERS, SCALE, feature(false));
    expect(built).toHaveLength(1);
    built[0].computeBoundingBox();
    expect(built[0].boundingBox!.max.z).toBeLessThan(1);
  });

  it("is stable for the same id", () => {
    const a = construction(ORIGIN_METERS, SCALE, feature(true, "way/1"))[0];
    const b = construction(ORIGIN_METERS, SCALE, feature(true, "way/1"))[0];
    expect(a.getAttribute("position").array).toEqual(
      b.getAttribute("position").array,
    );
  });
});
