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
  it("lays the bars along a north-south road", () => {
    const box = boxOf(feature(0));
    // long along the road (y), repeated across it (x)
    expect(box.max.x - box.min.x).toBeGreaterThan(6.5);
    expect(box.max.y - box.min.y).toBeLessThan(4.5);
    expect(box.max.z).toBeCloseTo(0.045, 5);
  });

  it("turns the bars with an east-west road", () => {
    const box = boxOf(feature(90));
    expect(box.max.x - box.min.x).toBeLessThan(4.5);
    expect(box.max.y - box.min.y).toBeGreaterThan(6.5);
  });

  it("has position, normal, uv and color on every vertex", () => {
    const built = crosswalk(ORIGIN_METERS, SCALE, feature(20))[0];
    const count = built.getAttribute("position").count;
    expect(count).toBe(7 * 6); // width 8 m gives seven bars, two triangles each
    for (const name of ["normal", "uv", "color"]) {
      expect(built.getAttribute(name).count).toBe(count);
    }
  });

  it("winds every bar counter-clockwise from above", () => {
    for (const bearing of [0, 45, 90, 200, 315]) {
      const built = crosswalk(ORIGIN_METERS, SCALE, feature(bearing))[0];
      const pos = built.getAttribute("position");
      for (let i = 0; i < pos.count; i += 3) {
        const ax = pos.getX(i),
          ay = pos.getY(i);
        const bx = pos.getX(i + 1),
          by = pos.getY(i + 1);
        const cx = pos.getX(i + 2),
          cy = pos.getY(i + 2);
        expect((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)).toBeGreaterThan(
          0,
        );
      }
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
