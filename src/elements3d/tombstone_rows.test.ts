import { describe, expect, it } from "vitest";

import { longestEdge, pointInRing, tombstoneSpots } from "./tombstone_rows";

const SQUARE: [number, number][] = [
  [0, 0],
  [40, 0],
  [40, 40],
  [0, 40],
];

describe("pointInRing", () => {
  it("accepts the inside and rejects the outside", () => {
    expect(pointInRing(20, 20, SQUARE)).toBe(true);
    expect(pointInRing(-1, 20, SQUARE)).toBe(false);
    expect(pointInRing(41, 20, SQUARE)).toBe(false);
  });
});

describe("longestEdge", () => {
  it("points along the longest boundary edge", () => {
    const rectangle: [number, number][] = [
      [0, 0],
      [60, 0],
      [60, 20],
      [0, 20],
    ];
    const { ux, uy } = longestEdge(rectangle);
    expect(ux).toBeCloseTo(1, 6);
    expect(uy).toBeCloseTo(0, 6);
  });
});

describe("tombstoneSpots", () => {
  it("lays out rows inside the polygon and clear of the wall", () => {
    const spots = tombstoneSpots([SQUARE]);
    expect(spots.length).toBeGreaterThan(20);
    for (const spot of spots) {
      expect(spot.x).toBeGreaterThan(0.5);
      expect(spot.x).toBeLessThan(39.5);
      expect(spot.y).toBeGreaterThan(0.5);
      expect(spot.y).toBeLessThan(39.5);
      // rows run along the longest edge, and a slab's width faces the path
      expect(spot.angle).toBeCloseTo(Math.PI / 2, 6);
      expect(spot.kind).toBeGreaterThanOrEqual(0);
      expect(spot.kind).toBeLessThan(6);
    }
  });

  it("is deterministic for the same seed and different for another", () => {
    const a = tombstoneSpots([SQUARE], { seed: 7 });
    const b = tombstoneSpots([SQUARE], { seed: 7 });
    const c = tombstoneSpots([SQUARE], { seed: 8 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("keeps tombstones out of a courtyard hole", () => {
    const hole: [number, number][] = [
      [14, 14],
      [26, 14],
      [26, 26],
      [14, 26],
    ];
    const spots = tombstoneSpots([SQUARE, hole]);
    expect(spots.length).toBeGreaterThan(0);
    for (const spot of spots) {
      const inHole = spot.x > 14 && spot.x < 26 && spot.y > 14 && spot.y < 26;
      expect(inHole).toBe(false);
    }
  });

  it("respects the cap, stretching the spacing instead of dropping rows", () => {
    const big: [number, number][] = [
      [0, 0],
      [400, 0],
      [400, 400],
      [0, 400],
    ];
    const spots = tombstoneSpots([big], { maxStones: 120 });
    expect(spots.length).toBeGreaterThan(60);
    expect(spots.length).toBeLessThanOrEqual(120);
  });
});
