import { describe, expect, it } from "vitest";

import { parkedCarsFromRow, parkedCarsFromRows } from "./parking_layout";

const row = {
  id: "way/1:+",
  coords: [
    [9.0, 45.0],
    [9.001, 45.0],
  ] as [number, number][],
  style: "parallel",
  pitch: 5.0,
  side: 1,
  occupancy: 100,
};

describe("parking layout", () => {
  it("walks one row at the pitch and keeps the side heading", () => {
    const cars = parkedCarsFromRow(row);
    expect(cars.length).toBe(15); // ~79 m at 5 m pitch, half-pitch inset
    expect(cars[0].lon).toBeGreaterThan(9.0);
    expect(cars[0].lat).toBeCloseTo(45, 5);
    for (const car of cars) {
      expect(car.heading).toBeCloseTo(Math.PI, 5);
    }
  });

  it("turns perpendicular and fishbone cars across the row", () => {
    const perpendicular = parkedCarsFromRow({
      ...row,
      style: "perpendicular",
      side: 1,
    });
    const fishbone = parkedCarsFromRow({ ...row, style: "fishbone", side: -1 });
    expect(perpendicular[0].heading).toBeCloseTo(Math.PI / 2, 5);
    expect(fishbone[0].heading).toBeCloseTo(-Math.PI / 4, 5);
  });

  it("honours occupancy and is stable for the same row", () => {
    const full = parkedCarsFromRow({ ...row, occupancy: 100 });
    const empty = parkedCarsFromRow({ ...row, occupancy: 0 });
    const partial = parkedCarsFromRow({ ...row, occupancy: 95 });
    expect(empty).toEqual([]);
    expect(partial.length).toBeLessThanOrEqual(full.length);
    expect(partial.length).toBeGreaterThan(0);
    expect(parkedCarsFromRow({ ...row, occupancy: 95 })).toEqual(partial);
  });

  it("concatenates rows and skips degenerate lines", () => {
    expect(parkedCarsFromRows([row]).length).toBeGreaterThan(0);
    expect(parkedCarsFromRow({ ...row, coords: [[9.0, 45.0]] })).toEqual([]);
  });
});
