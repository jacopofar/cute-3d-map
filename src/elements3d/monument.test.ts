import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { monument } from "./monument";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(
  kind: string,
  memorial?: string,
  id = "node/1",
): Geojson.Feature {
  return {
    type: "Feature",
    id,
    properties: { cmtype: "monument", kind, memorial },
    geometry: { type: "Point", coordinates: [9.19, 45.46] },
  };
}

function height(f: Geojson.Feature): number {
  const geometry = monument(ORIGIN_METERS, SCALE, f)[0];
  geometry.computeBoundingBox();
  return geometry.boundingBox!.max.z;
}

describe("monument", () => {
  it("builds colored geometry for every kind", () => {
    for (const [kind, memorial] of [
      ["monument", undefined],
      ["memorial", "statue"],
      ["memorial", "war_memorial"],
      ["memorial", "plaque"],
      ["memorial", "stone"],
      ["memorial", "ghost_bike"],
      ["obelisk", "obelisk"],
    ] as const) {
      const geometry = monument(
        ORIGIN_METERS,
        SCALE,
        feature(kind, memorial),
      )[0];
      expect(geometry, `${kind}/${memorial}`).toBeDefined();
      const position = geometry.getAttribute("position");
      expect(position.count).toBeGreaterThan(0);
      for (const name of ["normal", "uv", "color"]) {
        expect(geometry.getAttribute(name)?.count).toBe(position.count);
      }
      geometry.computeBoundingBox();
      expect(geometry.boundingBox!.min.z).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  it("makes the obelisk tall and the Stolperstein small", () => {
    expect(height(feature("obelisk"))).toBeGreaterThan(4);
    expect(height(feature("memorial", "stolperstein"))).toBeLessThan(0.2);
  });

  it("rejects a non-point", () => {
    const line: Geojson.Feature = {
      ...feature("monument"),
      geometry: {
        type: "LineString",
        coordinates: [
          [9.19, 45.46],
          [9.2, 45.46],
        ],
      },
    };
    expect(() => monument(ORIGIN_METERS, SCALE, line)).toThrow();
  });
});
