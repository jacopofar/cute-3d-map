import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { powerTower, powerWire } from "./power";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

describe("power", () => {
  it("builds a pylon from the ground to its height", () => {
    const f: Geojson.Feature = {
      type: "Feature",
      id: "node/1",
      properties: { cmtype: "power_tower", height: 30 },
      geometry: { type: "Point", coordinates: [9.19, 45.46] },
    };
    const built = powerTower(ORIGIN_METERS, SCALE, f);
    expect(built).toHaveLength(1);
    built[0].computeBoundingBox();
    expect(built[0].boundingBox!.min.z).toBeCloseTo(0, 5);
    expect(built[0].boundingBox!.max.z).toBeGreaterThanOrEqual(30);
  });

  it("sags a wire between its two endpoints", () => {
    const f: Geojson.Feature = {
      type: "Feature",
      id: "way/2",
      properties: { cmtype: "power_line", height: 26 },
      geometry: {
        type: "LineString",
        coordinates: [
          [9.189, 45.46],
          [9.191, 45.46],
        ],
      },
    };
    const built = powerWire(ORIGIN_METERS, SCALE, f);
    expect(built).toHaveLength(1);
    built[0].computeBoundingBox();
    expect(built[0].boundingBox!.max.z).toBeCloseTo(26, 5);
    expect(built[0].boundingBox!.min.z).toBeLessThan(26);
    expect(built[0].getAttribute("position").count).toBeGreaterThan(2);
  });

  it("ignores non-line geometries", () => {
    const f: Geojson.Feature = {
      type: "Feature",
      properties: { cmtype: "power_line", height: 20 },
      geometry: { type: "Point", coordinates: [9.19, 45.46] },
    };
    expect(powerWire(ORIGIN_METERS, SCALE, f)).toEqual([]);
  });
});
