import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { building } from "./building";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(properties: Record<string, unknown>): Geojson.Feature {
  return {
    type: "Feature",
    id: "way/766529419",
    properties,
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

describe("building", () => {
  it("lifts a building part from min_height to height", () => {
    const built = building(
      ORIGIN_METERS,
      SCALE,
      feature({ building: "university", height: 15, base: 10 }),
    );
    expect(built).toHaveLength(1);
    built[0].walls.computeBoundingBox();
    expect(built[0].walls.boundingBox!.min.z).toBeCloseTo(10, 5);
    expect(built[0].walls.boundingBox!.max.z).toBeCloseTo(15, 5);
    built[0].roof?.computeBoundingBox();
    if (built[0].roof) {
      expect(built[0].roof.boundingBox!.min.z).toBeGreaterThanOrEqual(15);
    }
  });

  it("keeps an ordinary building on the ground", () => {
    const built = building(
      ORIGIN_METERS,
      SCALE,
      feature({ building: "yes", height: 12 }),
    );
    built[0].walls.computeBoundingBox();
    expect(built[0].walls.boundingBox!.min.z).toBeCloseTo(0, 5);
  });
});
