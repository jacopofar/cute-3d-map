import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { rooftop } from "./rooftop";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(kind: string): Geojson.Feature {
  return {
    type: "Feature",
    id: "node/1",
    properties: { cmtype: "rooftop", kind, base: 10, height: 5, size: 3 },
    geometry: { type: "Point", coordinates: [9.19, 45.46] },
  };
}

describe("rooftop", () => {
  it("places props above the carrying building", () => {
    for (const kind of ["water_tower", "chimney", "antenna", "solar"]) {
      const built = rooftop(ORIGIN_METERS, SCALE, feature(kind));
      expect(built).toHaveLength(1);
      built[0].computeBoundingBox();
      expect(built[0].boundingBox!.min.z).toBeGreaterThanOrEqual(10);
      expect(built[0].boundingBox!.max.z).toBeGreaterThan(10);
    }
  });

  it("returns nothing for a line", () => {
    const f = feature("antenna");
    f.geometry = {
      type: "LineString",
      coordinates: [
        [9.19, 45.46],
        [9.2, 45.47],
      ],
    };
    expect(rooftop(ORIGIN_METERS, SCALE, f)).toEqual([]);
  });
});
