import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { furniture } from "./furniture";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

const KINDS = [
  "bollard",
  "bin",
  "bike_rack",
  "post_box",
  "drinking_water",
  "info_board",
  "hydrant",
] as const;

function feature(kind: string, id = "node/1"): Geojson.Feature {
  return {
    type: "Feature",
    id,
    properties: { cmtype: "furniture", furniture: kind },
    geometry: { type: "Point", coordinates: [9.19, 45.46] },
  };
}

describe("furniture", () => {
  it("builds a colored, finite box mesh for every kind", () => {
    for (const kind of KINDS) {
      const built = furniture(ORIGIN_METERS, SCALE, feature(kind));
      expect(built, kind).toHaveLength(1);
      const geometry = built[0];
      const position = geometry.getAttribute("position");
      expect(position.count, kind).toBeGreaterThanOrEqual(12);
      expect(position.count % 3, kind).toBe(0);
      for (const name of ["normal", "uv", "color"]) {
        expect(geometry.getAttribute(name)?.count, name).toBe(position.count);
      }
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      // props sit on the ground, are at most 2 m tall, and stay near the point
      expect(box.min.z, kind).toBeGreaterThanOrEqual(-1e-6);
      expect(box.max.z, kind).toBeLessThanOrEqual(2.1);
      expect(box.max.x - box.min.x, kind).toBeLessThan(2);
      expect(box.max.y - box.min.y, kind).toBeLessThan(2);
    }
  });

  it("keeps the feature position and rotates a line-mapped rack", () => {
    const a = furniture(ORIGIN_METERS, SCALE, feature("bike_rack", "node/1"));
    const b = furniture(ORIGIN_METERS, SCALE, feature("bike_rack", "node/2"));
    // different ids get different stable quarter-turns
    expect(a[0].getAttribute("position").array).not.toEqual(
      b[0].getAttribute("position").array,
    );
    const bearing = feature("bike_rack", "node/3");
    bearing.properties = { ...bearing.properties, angle: 0 };
    const rotated = furniture(ORIGIN_METERS, SCALE, bearing)[0];
    rotated.computeBoundingBox();
    // local x is the rack's length; a north bearing turns it along y
    const box = rotated.boundingBox!;
    expect(box.max.y - box.min.y).toBeGreaterThan(box.max.x - box.min.x);
  });

  it("ignores an unknown kind and rejects a non-point", () => {
    expect(furniture(ORIGIN_METERS, SCALE, feature("toaster"))).toEqual([]);
    const line: Geojson.Feature = {
      type: "Feature",
      id: "way/1",
      properties: { cmtype: "furniture", furniture: "bin" },
      geometry: {
        type: "LineString",
        coordinates: [
          [9.19, 45.46],
          [9.2, 45.46],
        ],
      },
    };
    expect(() => furniture(ORIGIN_METERS, SCALE, line)).toThrow();
  });
});
