import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { crosswalk, crosswalkInfo } from "./crosswalk";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(
  bearing: number | undefined,
  width = 8,
  id = "node/1",
): Geojson.Feature {
  return {
    type: "Feature",
    id,
    properties: {
      cmtype: "crosswalk",
      bearing,
      width,
      crossing: "marked",
    },
    geometry: { type: "Point", coordinates: [9.19, 45.46] },
  };
}

function boxOf(f: Geojson.Feature) {
  const built = crosswalk(ORIGIN_METERS, SCALE, f);
  expect(built).toHaveLength(1);
  built[0].computeBoundingBox();
  return built[0].boundingBox!;
}

describe("crosswalk", () => {
  it("lays the bars across a north-south road", () => {
    const box = boxOf(feature(0));
    // width across the road (x), shallow along it (y)
    expect(box.max.x - box.min.x).toBeGreaterThan(7.5);
    expect(box.max.y - box.min.y).toBeLessThan(6.5);
    expect(box.max.z).toBeCloseTo(0.045, 5);
  });

  it("turns the bars with an east-west road", () => {
    const box = boxOf(feature(90));
    expect(box.max.x - box.min.x).toBeLessThan(6.5);
    expect(box.max.y - box.min.y).toBeGreaterThan(7.5);
  });

  it("has position, normal, uv and color on every vertex", () => {
    const built = crosswalk(ORIGIN_METERS, SCALE, feature(20))[0];
    const count = built.getAttribute("position").count;
    expect(count).toBe(5 * 6); // five bars, two triangles each
    for (const name of ["normal", "uv", "color"]) {
      expect(built.getAttribute(name).count).toBe(count);
    }
  });

  it("skips a crossing without a road bearing", () => {
    expect(crosswalk(ORIGIN_METERS, SCALE, feature(undefined))).toEqual([]);
  });

  it("keeps the point for the popup", () => {
    const info = crosswalkInfo(feature(0));
    expect(info).toEqual({
      id: "node/1",
      lon: 9.19,
      lat: 45.46,
      crossing: "marked",
      markings: undefined,
    });
  });
});
