import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../projection";
import { playground } from "./playground";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(id = "way/1"): Geojson.Feature {
  return {
    type: "Feature",
    id,
    properties: { cmtype: "playground", size: 12 },
    geometry: { type: "Point", coordinates: [9.19, 45.46] },
  };
}

describe("playground", () => {
  it("builds a patch with swings, a slide and a spring rider", () => {
    const built = playground(ORIGIN_METERS, SCALE, feature());
    expect(built).toHaveLength(1);
    const geometry = built[0];
    const position = geometry.getAttribute("position");
    expect(position.count).toBeGreaterThan(0);
    for (const name of ["normal", "uv", "color"]) {
      expect(geometry.getAttribute(name)?.count).toBe(position.count);
    }
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    // the 12 m patch is the widest part
    expect(box.max.x - box.min.x).toBeGreaterThan(11);
    expect(box.max.z).toBeGreaterThan(2);
    expect(box.min.z).toBeGreaterThanOrEqual(-1e-6);
  });

  it("is stable for the same id", () => {
    const a = playground(ORIGIN_METERS, SCALE, feature("way/1"))[0];
    const b = playground(ORIGIN_METERS, SCALE, feature("way/1"))[0];
    expect(a.getAttribute("position").array).toEqual(
      b.getAttribute("position").array,
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
    expect(() => playground(ORIGIN_METERS, SCALE, line)).toThrow();
  });
});
