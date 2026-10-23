import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { wall } from "./wall";
import { gate } from "./gate";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

const line: Geojson.Feature = {
  type: "Feature",
  id: "way/1",
  properties: { cmtype: "wall", wall: "brick", height: 2 },
  geometry: {
    type: "LineString",
    coordinates: [
      [9.189, 45.459],
      [9.191, 45.459],
    ],
  },
};

describe("wall and gate", () => {
  it("builds a solid wall along the line", () => {
    const built = wall(ORIGIN_METERS, SCALE, line);
    expect(built).toHaveLength(1);
    const count = built[0].getAttribute("position").count;
    for (const name of ["normal", "uv", "color"]) {
      expect(built[0].getAttribute(name).count).toBe(count);
    }
    built[0].computeBoundingBox();
    expect(built[0].boundingBox!.min.z).toBeCloseTo(0, 5);
    expect(built[0].boundingBox!.max.z).toBeCloseTo(2, 5);
  });

  it("builds a gate leaf between two posts", () => {
    const built = gate(ORIGIN_METERS, SCALE, {
      type: "Feature",
      id: "node/1",
      properties: { cmtype: "gate", bearing: 0, width: 3 },
      geometry: { type: "Point", coordinates: [9.19, 45.46] },
    });
    expect(built).toHaveLength(1);
    built[0].computeBoundingBox();
    expect(built[0].boundingBox!.max.z).toBeGreaterThan(1.3);
  });

  it("returns nothing for a point wall", () => {
    expect(
      wall(ORIGIN_METERS, SCALE, {
        ...line,
        geometry: { type: "Point", coordinates: [9.19, 45.46] },
      }),
    ).toEqual([]);
  });
});
