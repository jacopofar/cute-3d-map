import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { cemetery, MAX_TOMBSTONES_PER_TILE } from "./cemetery";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(
  coordinates: Geojson.Position[][][],
): Geojson.Feature<Geojson.MultiPolygon> {
  return {
    type: "Feature",
    id: "way/1",
    properties: { cmtype: "cemetery" },
    geometry: { type: "MultiPolygon", coordinates },
  };
}

const SQUARE: Geojson.Position[][] = [
  [
    [9.19, 45.46],
    [9.191, 45.46],
    [9.191, 45.461],
    [9.19, 45.461],
    [9.19, 45.46],
  ],
];

describe("cemetery", () => {
  it("builds one geometry with the ground and its tombstones", () => {
    const built = cemetery(ORIGIN_METERS, SCALE, feature([SQUARE]));
    expect(built).toHaveLength(1);
    const geometry = built[0];
    const position = geometry.getAttribute("position");
    expect(position.count).toBeGreaterThan(0);
    expect(position.count % 3).toBe(0);
    for (const name of ["normal", "uv", "color"]) {
      expect(geometry.getAttribute(name)?.count).toBe(position.count);
    }
    // one draw call per feature, no index
    expect(geometry.index).toBeNull();
    // the tombstone budget bounds the geometry: ground + stones
    const perStone = 12 * 3; // 12 triangles, 3 vertices each
    expect(position.count).toBeLessThan(MAX_TOMBSTONES_PER_TILE * perStone * 2);
    for (let i = 0; i < position.count; i++) {
      expect(Number.isFinite(position.getX(i))).toBe(true);
      expect(Number.isFinite(position.getY(i))).toBe(true);
      expect(Number.isFinite(position.getZ(i))).toBe(true);
    }
  });

  it("returns a geometry per polygon part", () => {
    const second: Geojson.Position[][] = [
      [
        [9.192, 45.462],
        [9.193, 45.462],
        [9.193, 45.463],
        [9.192, 45.463],
        [9.192, 45.462],
      ],
    ];
    expect(
      cemetery(ORIGIN_METERS, SCALE, feature([SQUARE, second])),
    ).toHaveLength(2);
  });
});
