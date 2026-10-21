import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { terrace } from "./terrace";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(id = "node/1"): Geojson.Feature {
  return {
    type: "Feature",
    id,
    properties: { cmtype: "terrace", terrace: "cafe", name: "Bar" },
    geometry: { type: "Point", coordinates: [9.19, 45.46] },
  };
}

describe("terrace", () => {
  it("builds umbrellas, tables and chairs in one merged geometry", () => {
    const built = terrace(ORIGIN_METERS, SCALE, feature());
    expect(built).toHaveLength(1);
    const geometry = built[0];
    const position = geometry.getAttribute("position");
    expect(position.count).toBeGreaterThan(0);
    for (const name of ["normal", "uv", "color"]) {
      expect(geometry.getAttribute(name)?.count).toBe(position.count);
    }
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    // a terrace is a few meters wide and the umbrella canopy is above 2 m
    expect(box.max.x - box.min.x).toBeGreaterThan(2.5);
    expect(box.max.z).toBeGreaterThan(2.4);
    expect(box.min.z).toBeGreaterThanOrEqual(0);
  });

  it("is stable for the same id and varies with another", () => {
    const a = terrace(ORIGIN_METERS, SCALE, feature("node/1"))[0];
    const b = terrace(ORIGIN_METERS, SCALE, feature("node/1"))[0];
    const c = terrace(ORIGIN_METERS, SCALE, feature("node/2"))[0];
    expect(a.getAttribute("position").array).toEqual(
      b.getAttribute("position").array,
    );
    expect(a.getAttribute("position").array).not.toEqual(
      c.getAttribute("position").array,
    );
  });

  it("rejects a non-point", () => {
    const line: Geojson.Feature = {
      ...feature(),
      geometry: {
        type: "LineString",
        coordinates: [
          [9.19, 45.46],
          [9.2, 45.46],
        ],
      },
    };
    expect(() => terrace(ORIGIN_METERS, SCALE, line)).toThrow();
  });
});
