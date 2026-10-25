import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857, scaleFactorAt, toModelCoords } from "./projection";

describe("epsg4326toEpsg3857", () => {
  it("puts null island at the origin", () => {
    // sub-nanometer float noise from Math.tan(pi/4); irrelevant at city scale
    const [x, y] = epsg4326toEpsg3857([0, 0]);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
  });

  it("puts the antimeridian at the Web Mercator world edge", () => {
    const [x] = epsg4326toEpsg3857([180, 0]);
    expect(x).toBeCloseTo(20037508.34, 2);
  });

  it("spans a full world width from -180 to 180", () => {
    const [west] = epsg4326toEpsg3857([-180, 0]);
    const [east] = epsg4326toEpsg3857([180, 0]);
    expect(east - west).toBeCloseTo(2 * 20037508.34, 2);
  });

  it("grows the northing with latitude", () => {
    const [, milan] = epsg4326toEpsg3857([9.19, 45.46]);
    const [, oslo] = epsg4326toEpsg3857([10.75, 59.91]);
    expect(oslo).toBeGreaterThan(milan);
    expect(milan).toBeGreaterThan(0);
  });
});

describe("scaleFactorAt", () => {
  it("is 1 at the equator and shrinks towards the poles", () => {
    expect(scaleFactorAt(0)).toBe(1);
    expect(scaleFactorAt(60)).toBeCloseTo(0.5, 10);
    expect(scaleFactorAt(45.46)).toBeCloseTo(0.7014, 3);
  });
});

describe("toModelCoords", () => {
  const origin: [number, number] = [9.19, 45.46];

  it("puts the origin itself at zero", () => {
    const meters = epsg4326toEpsg3857(origin);
    expect(toModelCoords(origin, meters, 1)).toEqual([0, 0]);
  });

  it("scales the offset by the cos(latitude) factor", () => {
    const meters = epsg4326toEpsg3857(origin);
    const offset = toModelCoords([9.2, 45.46], meters, 1);
    const scaled = toModelCoords([9.2, 45.46], meters, 0.7);
    expect(scaled[0]).toBeCloseTo(offset[0] * 0.7, 10);
    // moving east must not move the northing
    expect(offset[1]).toBeCloseTo(0, 10);
  });

  it("is antisymmetric around the origin", () => {
    const meters = epsg4326toEpsg3857(origin);
    const east = toModelCoords([9.2, 45.46], meters, 1);
    const west = toModelCoords([9.18, 45.46], meters, 1);
    expect(east[0]).toBeCloseTo(-west[0], 6);
  });
});
