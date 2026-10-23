import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { parkPath, parkPathColor } from "./park_path";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(properties: Record<string, unknown>): Geojson.Feature {
  return {
    type: "Feature",
    id: "way/1",
    properties: { cmtype: "park_path", ...properties },
    geometry: {
      type: "LineString",
      coordinates: [
        [9.189, 45.46],
        [9.191, 45.46],
      ],
    },
  };
}

describe("park path", () => {
  it("defaults walking paths to light brown and cycle paths to brick", () => {
    expect(parkPathColor(feature({ kind: "walk" })).getHexString()).toBe(
      "c8a273",
    );
    expect(parkPathColor(feature({ kind: "bike" })).getHexString()).toBe(
      "a85f4a",
    );
  });

  it("uses the mapped surface color when there is one", () => {
    expect(
      parkPathColor(
        feature({ kind: "walk", surface: "asphalt" }),
      ).getHexString(),
    ).toBe("4f5354");
    expect(
      parkPathColor(
        feature({ kind: "bike", surface: "gravel" }),
      ).getHexString(),
    ).toBe("b69a73");
  });

  it("lays a flat ribbon just above the green surface", () => {
    const built = parkPath(ORIGIN_METERS, SCALE, feature({ kind: "walk" }));
    expect(built).toHaveLength(1);
    built[0].computeBoundingBox();
    expect(built[0].boundingBox!.min.z).toBeCloseTo(0.03, 5);
    expect(built[0].boundingBox!.max.z).toBeCloseTo(0.07, 5);
    expect(built[0].getAttribute("position").count).toBeGreaterThan(0);
  });
});
