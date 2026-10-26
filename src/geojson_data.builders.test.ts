import type Geojson from "geojson";
import { describe, expect, it, vi } from "vitest";

import { epsg4326toEpsg3857 } from "./projection";
import { BUILDER_CMTYPES, geoJSONtoGeometries } from "./geojson_data";

// A feature per cmtype, at a plausible shape for that layer, and the point of
// the exercise is the dispatch: one table row per layer, so a builder that
// starts throwing on ordinary input, or a tag whose builder is missing, shows
// up here instead of as a blank patch of map. The geometry itself is asserted
// in each builder's own test file.
const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

const POINT: [number, number] = [9.19, 45.46];
// about 150 m by 220 m: big enough for the area layers whose builders reject a
// sliver (construction wants 80 m², a cemetery wants room for rows)
const AREA = [
  [9.189, 45.459],
  [9.191, 45.459],
  [9.191, 45.461],
  [9.189, 45.461],
  [9.189, 45.459],
];
const LINE = [
  [9.189, 45.46],
  [9.191, 45.46],
];

function feature(
  cmtype: string,
  geometry: Geojson.Geometry,
  properties: Record<string, unknown> = {},
): Geojson.Feature {
  return {
    type: "Feature",
    id: `way/1`,
    properties: { cmtype, ...properties },
    geometry,
  };
}

function point(): Geojson.Geometry {
  return { type: "Point", coordinates: POINT };
}
function line(): Geojson.Geometry {
  return { type: "LineString", coordinates: LINE };
}
function area(): Geojson.Geometry {
  return { type: "Polygon", coordinates: [AREA] };
}

const FIXTURES: [string, Geojson.Feature][] = [
  ["aeroway", feature("aeroway", line(), { aeroway: "runway" })],
  ["bench", feature("bench", point(), { direction: 90 })],
  ["bridge", feature("bridge", line(), { class: "highway" })],
  ["building", feature("building", area(), { building: "yes", height: 12 })],
  ["cemetery", feature("cemetery", area())],
  ["construction", feature("construction", area())],
  ["crosswalk", feature("crosswalk", point(), { bearing: 0, width: 8 })],
  ["fence", feature("fence", line(), { barrier: "fence" })],
  ["fountain", feature("fountain", point(), { size: 6 })],
  ["furniture", feature("furniture", point(), { furniture: "bollard" })],
  ["gate", feature("gate", point(), { bearing: 0, width: 4 })],
  ["green", feature("green", area())],
  ["lane", feature("lane", line(), { width: 8, lanes: 2 })],
  ["monument", feature("monument", point(), { kind: "statue" })],
  ["park_path", feature("park_path", line(), { kind: "walk" })],
  ["platform", feature("platform", area(), { kind: "platform" })],
  ["playground", feature("playground", point(), { size: 10 })],
  ["power_line", feature("power_line", line(), { voltage: 380000, wires: 3 })],
  ["power_tower", feature("power_tower", point(), { height: 30 })],
  ["rail", feature("rail", line(), { kind: "rail" })],
  [
    "road_marking",
    feature("road_marking", point(), {
      kind: "stop",
      directions: [90],
      width: 8,
      lanes: 2,
    }),
  ],
  ["rooftop", feature("rooftop", point(), { rooftop: "water_tower", base: 0 })],
  ["sidewalk", feature("sidewalk", area())],
  ["terrace", feature("terrace", point(), { terrace: "cafe" })],
  ["transit_stop", feature("transit_stop", point(), { stop: "bus" })],
  ["tree", feature("tree", point(), { type: "broadleaf", size: 2 })],
  ["tree_row", feature("tree_row", line(), { type: "broadleaf", size: 2 })],
  ["tunnel", feature("tunnel", point(), { angle: 0 })],
  ["wall", feature("wall", line(), { wall: "stone" })],
  ["water", feature("water", area(), { water: "lake" })],
];

describe("geoJSONtoGeometries", () => {
  it("has a fixture for every builder tilegen emits", () => {
    expect(FIXTURES.map(([cmtype]) => cmtype).sort()).toEqual(
      [...BUILDER_CMTYPES].sort(),
    );
  });

  it.each(FIXTURES)("builds %s without throwing", (_cmtype, f) => {
    expect(() => geoJSONtoGeometries(f, ORIGIN_METERS, SCALE)).not.toThrow();
  });

  it("returns a group per mesh kind, with the geometry in it", () => {
    // a building is the multi-kind case: walls and, when the roof is pitched,
    // its own roof mesh, and it must not claim a kind it does not produce
    const groups = geoJSONtoGeometries(
      feature("building", area(), {
        building: "yes",
        height: 12,
        roof_shape: "gabled",
        roof_color: "#884422",
      }),
      ORIGIN_METERS,
      SCALE,
    );
    expect(groups.map((group) => group.kind)).toEqual(["building", "roof"]);
    for (const group of groups) {
      expect(group.geometries.length).toBeGreaterThan(0);
    }
  });

  it("ignores a feature with no cmtype", () => {
    const bare: Geojson.Feature = {
      type: "Feature",
      id: "way/1",
      properties: {},
      geometry: point(),
    };
    expect(geoJSONtoGeometries(bare, ORIGIN_METERS, SCALE)).toEqual([]);
  });

  it("logs and ignores an unknown cmtype", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const unknown = feature("hovercraft", point());
    expect(geoJSONtoGeometries(unknown, ORIGIN_METERS, SCALE)).toEqual([]);
    expect(error).toHaveBeenCalledWith("unknown cmtype: hovercraft");
    error.mockRestore();
  });
});
