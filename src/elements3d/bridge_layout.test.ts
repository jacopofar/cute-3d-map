import { describe, expect, it } from "vitest";

import {
  bridgeDeckHeight,
  bridgeDeckWidth,
  deckSolid,
  deckWalls,
  DEFAULT_BRIDGE_WIDTH,
  PORTAL_HEIGHT,
  portalSolid,
  rampHeight,
} from "./bridge_layout";

describe("bridgeDeckWidth", () => {
  it("maps known classes and falls back for unknown ones", () => {
    expect(bridgeDeckWidth("motorway")).toBe(16);
    expect(bridgeDeckWidth("footway")).toBe(5);
    expect(bridgeDeckWidth("rail")).toBe(8);
    expect(bridgeDeckWidth("something-else")).toBe(DEFAULT_BRIDGE_WIDTH);
    expect(bridgeDeckWidth(undefined)).toBe(DEFAULT_BRIDGE_WIDTH);
  });
});

describe("bridgeDeckHeight", () => {
  it("floats at the base and steps with the layer", () => {
    // a plain bridge=yes has layer 1 or nothing; both float at the base
    expect(bridgeDeckHeight(1)).toBe(4.5);
    expect(bridgeDeckHeight(NaN)).toBe(4.5);
    expect(bridgeDeckHeight(0)).toBe(4.5); // max(1, 0)
    expect(bridgeDeckHeight(2)).toBe(9);
  });
});

describe("rampHeight", () => {
  it("is zero at both ends and the full height in the middle", () => {
    // a 100 m bridge with a 15 m ramp
    expect(rampHeight(0, 100, 5)).toBe(0);
    expect(rampHeight(100, 100, 5)).toBe(0);
    expect(rampHeight(50, 100, 5)).toBeCloseTo(5);
    // rising, never above the deck height
    const mid = rampHeight(7.5, 100, 5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(5);
  });

  it("clamps the ramp to half the bridge, so a short one still rises", () => {
    // a 10 m bridge: the ramp is 5 m, so the middle is nearly the full height
    expect(rampHeight(5, 10, 4)).toBeCloseTo(4);
    // a degenerate total must not divide by zero
    expect(rampHeight(0, 0, 4)).toBe(4);
  });
});

describe("deckSolid", () => {
  it("builds a closed slab of full triangles", () => {
    const positions = deckSolid(
      [
        [0, 0],
        [50, 0],
        [100, 0],
      ],
      10,
      5,
    );
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.length % 9).toBe(0); // whole triangles of 3 vertices
    // every vertex has an x, y and z
    expect(positions.length % 3).toBe(0);
  });

  it("returns nothing for a degenerate line", () => {
    expect(deckSolid([[0, 0]], 10, 5)).toEqual([]);
    expect(deckSolid([], 10, 5)).toEqual([]);
  });
});

describe("deckWalls", () => {
  it("walls every edge of a closed ring", () => {
    const ring: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const positions = deckWalls(ring, 4);
    // four edges, two triangles each
    expect(positions.length).toBe(4 * 2 * 3 * 3);
    // the wall top sits at the deck height
    const zs = positions.filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs)).toBe(4);
    expect(Math.min(...zs)).toBe(0);
  });
});

describe("portalSolid", () => {
  it("builds a frame of whole triangles at the portal height", () => {
    const positions = portalSolid([100, 200], Math.PI / 2, 8);
    expect(positions.length % 3).toBe(0);
    expect(positions.length % 9).toBe(0);
    const zs = positions.filter((_, i) => i % 3 === 2);
    // the pillars start at the ground and the frame tops out at the height
    expect(Math.min(...zs)).toBe(0);
    expect(Math.max(...zs)).toBeCloseTo(PORTAL_HEIGHT);
  });
});
