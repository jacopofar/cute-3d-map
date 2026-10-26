import { describe, expect, it } from "vitest";

import { hashSeed, makeRng } from "./random";

describe("hashSeed", () => {
  // The value is the seed of every procedural detail, so it is frozen here: a
  // change to the hash silently re-rolls every window, balcony and roof in the
  // city, which is exactly the kind of drift a test should stop.
  it("is stable for a known id", () => {
    expect(hashSeed("way/12345")).toBe(0x0a099c6c);
  });

  it("is an unsigned 32-bit integer", () => {
    for (const text of ["", "node/1", "relation/999999999", "ä"]) {
      const h = hashSeed(text);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it("separates ids that differ", () => {
    expect(hashSeed("way/1")).not.toBe(hashSeed("way/2"));
    expect(hashSeed("way/1")).not.toBe(hashSeed("node/1"));
  });
});

describe("makeRng", () => {
  it("replays the same sequence for the same seed", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("stays in [0, 1)", () => {
    const rng = makeRng(7);
    for (let i = 0; i < 100; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("gives different sequences for different seeds", () => {
    expect(makeRng(1)()).not.toBe(makeRng(2)());
  });
});
