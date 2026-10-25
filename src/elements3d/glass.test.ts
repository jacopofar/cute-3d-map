import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../projection";
import { geoJSONtoGeometries, type BuildingInfo } from "../geojson_data";
import { tileFacadeDetail } from "./facade";
import { isGlass } from "./glass";

const ORIGIN: [number, number] = [9.18, 45.5];
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);

function square(): [number, number][] {
  const [lon, lat] = ORIGIN;
  return [
    [lon - 7.7e-5, lat - 5.4e-5],
    [lon + 7.7e-5, lat - 5.4e-5],
    [lon + 7.7e-5, lat + 5.4e-5],
    [lon - 7.7e-5, lat + 5.4e-5],
  ];
}

const info = (over: Partial<BuildingInfo> = {}): BuildingInfo => ({
  rings: [square()],
  height: 40,
  imputed: [],
  ...over,
});

describe("isGlass", () => {
  it("reads the flag tilegen reports", () => {
    expect(isGlass({ glass: true })).toBe(true);
    expect(isGlass({ glass: false })).toBe(false);
    expect(isGlass({})).toBe(false);
    expect(isGlass(undefined)).toBe(false);
  });

  it("classifies raw material tags, including `;` lists", () => {
    expect(isGlass({ "building:material": "glass" })).toBe(true);
    expect(isGlass({ "building:facade:material": "Mirror" })).toBe(true);
    expect(isGlass({ "building:material": "plaster;glass" })).toBe(true);
    expect(isGlass({ "building:material": "brick" })).toBe(false);
  });
});

describe("glass buildings", () => {
  it("get their own kind, keeping the roof", () => {
    const groups = geoJSONtoGeometries(
      {
        type: "Feature",
        properties: { cmtype: "building", height: 40, glass: true },
        geometry: { type: "Polygon", coordinates: [square()] },
      },
      ORIGIN_METERS,
      SCALE,
    );
    expect(groups.map((group) => group.kind)).toContain("glass");
    expect(groups.map((group) => group.kind)).not.toContain("building");
  });

  it("get no windows, balconies or door", () => {
    const detail = tileFacadeDetail(ORIGIN_METERS, SCALE, [
      info({ glass: true }),
    ]);
    expect(detail.windows).toBeNull();
    expect(detail.balconies).toBeNull();
    // the neighbours keep theirs: the skip is per building
    const mixed = tileFacadeDetail(ORIGIN_METERS, SCALE, [
      info({ glass: true }),
      info(),
    ]);
    expect(mixed.windows).not.toBeNull();
  });
});
