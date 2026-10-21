import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { rail } from "./rail";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(kind = "rail", id = "way/1"): Geojson.Feature {
  return {
    type: "Feature",
    id,
    properties: { cmtype: "rail", kind },
    geometry: {
      type: "LineString",
      coordinates: [
        [9.188, 45.459],
        [9.192, 45.461],
      ],
    },
  };
}

describe("rail", () => {
  it("builds ballast, rails, sleepers, wire and poles", () => {
    const built = rail(ORIGIN_METERS, SCALE, feature());
    expect(built).toHaveLength(1);
    const geometry = built[0];
    const position = geometry.getAttribute("position");
    expect(position.count).toBeGreaterThan(100);
    for (const name of ["normal", "uv", "color"]) {
      expect(geometry.getAttribute(name).count).toBe(position.count);
    }
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.z).toBeGreaterThan(5.5);
    expect(geometry.boundingBox!.min.z).toBeGreaterThanOrEqual(0);
  });

  it("leaves tram tracks without ballast or sleepers", () => {
    const track = rail(ORIGIN_METERS, SCALE, feature("rail"))[0];
    const tram = rail(ORIGIN_METERS, SCALE, feature("tram"))[0];
    expect(tram.getAttribute("position").count).toBeLessThan(
      track.getAttribute("position").count,
    );
  });

  it("is stable for the same feature", () => {
    const a = rail(ORIGIN_METERS, SCALE, feature())[0];
    const b = rail(ORIGIN_METERS, SCALE, feature())[0];
    expect(a.getAttribute("position").array).toEqual(
      b.getAttribute("position").array,
    );
  });

  it("returns nothing for a non-line", () => {
    const f = feature();
    f.geometry = { type: "Point", coordinates: [9.19, 45.46] };
    expect(rail(ORIGIN_METERS, SCALE, f)).toEqual([]);
  });
});
