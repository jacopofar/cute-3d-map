import { describe, expect, it } from "vitest";

import {
  CROSSING_BRAKE_M,
  CROSSING_BRAKE_TO,
  CROSSING_GREEN_M,
  CROSSING_GREEN_PEAK,
  CROSSING_RECOVER_M,
  CROSSING_RECOVER_PEAK,
  axisOf,
  coordKey,
  crossingShift,
  crossingsAlongLoop,
  lightGreen,
  type PreparedCrossing,
  type PreparedRun,
} from "./traffic_math";

describe("lightGreen", () => {
  it("alternates the two axes every 8 seconds", () => {
    expect(lightGreen(0, 0)).toBe(true);
    expect(lightGreen(1, 0)).toBe(false);
    expect(lightGreen(0, 8)).toBe(false);
    expect(lightGreen(1, 8)).toBe(true);
    expect(lightGreen(0, 16)).toBe(true);
  });
});

describe("axisOf", () => {
  it("is 0 for east-west and 1 for north-south travel", () => {
    expect(axisOf([9.18, 45.5], [9.19, 45.5])).toBe(0);
    expect(axisOf([9.18, 45.5], [9.18, 45.51])).toBe(1);
  });
});

describe("coordKey", () => {
  it("collides a 7-decimal tile coordinate with the raw node coordinate", () => {
    expect(coordKey(9.1747413, 45.5)).toBe(coordKey(9.1747412999999, 45.5));
  });
});

// a crossing at 10 m/s: the distances turn into these loop-time widths
const V = 10;
const crossing = (t: number, axis: 0 | 1): PreparedCrossing => ({
  t,
  axis,
  brake: CROSSING_BRAKE_M / V,
  recover: CROSSING_RECOVER_M / V,
  near: CROSSING_GREEN_M / V,
});

describe("crossingShift", () => {
  // the renderer advances `now` and `tau` together (so now - d stays fixed while
  // a vehicle passes a bump); the tests do the same
  const at = (tau: number, c: PreparedCrossing): number =>
    crossingShift(tau, [c], tau);
  const speedAt = (tau: number, c: PreparedCrossing, step = 1e-4): number =>
    1 + (at(tau + step, c) - at(tau, c)) / step;

  it("is zero outside the window", () => {
    const c = crossing(20, 0);
    expect(at(20 - c.brake - 0.1, c)).toBe(0);
    expect(at(20 + c.recover + 0.1, c)).toBe(0);
  });

  it("slows to the floor on a red axis and eases on a green one", () => {
    // at t = 20 (the crossing wall time): axis 0 is green, axis 1 is red
    const green = crossing(20, 0);
    const red = crossing(20, 1);
    // red: slowest at the middle of the braking stretch, back to cruise at the
    // crossing, and The recover shoulder peaks in the middle of the recovery
    expect(speedAt(20 - red.brake / 2, red)).toBeCloseTo(CROSSING_BRAKE_TO, 2);
    expect(speedAt(20, red)).toBeCloseTo(1, 2);
    expect(speedAt(20 + red.recover / 2, red)).toBeCloseTo(
      CROSSING_RECOVER_PEAK,
      2,
    );
    // green: a gentle symmetric nudge the other way
    expect(speedAt(20 - green.near / 2, green)).toBeCloseTo(
      CROSSING_GREEN_PEAK,
      2,
    );
    expect(speedAt(20 + green.near / 2, green)).toBeCloseTo(
      2 - CROSSING_GREEN_PEAK,
      2,
    );
  });

  it("is specular: the shift returns to zero, so the lap is unchanged", () => {
    const red = crossing(20, 1);
    expect(at(20 - red.brake, red)).toBeCloseTo(0);
    expect(at(20 + red.recover, red)).toBeCloseTo(0);
    // the lag peaks at the crossing itself
    expect(at(20, red)).toBeCloseTo(
      -((1 - CROSSING_BRAKE_TO) * red.brake) / 1.875,
    );
  });

  it("ignores crossings beyond the window ahead (regression)", () => {
    // a crossing far ahead must not contribute: the walk skips on the window,
    // not on the sign of the distance
    expect(at(20, crossing(2000, 0))).toBe(0);
  });

  it("is zero with no crossings", () => {
    expect(crossingShift(5, [], 0)).toBe(0);
  });

  it("never reverses the drawn motion", () => {
    // a dense city stretch: bumps as close as the merge threshold allows
    const crossings = [crossing(20, 0), crossing(60, 1), crossing(100, 0)];
    const period = 130;
    const step = 0.001;
    let previous: number | null = null;
    let minSpeed = Infinity;
    let maxSpeed = -Infinity;
    for (let tau = 0; tau < period; tau += step) {
      const drawn = tau + crossingShift(tau, crossings, 1000 + tau);
      if (previous !== null) {
        const speed = (drawn - previous) / step;
        minSpeed = Math.min(minSpeed, speed);
        maxSpeed = Math.max(maxSpeed, speed);
      }
      previous = drawn;
    }
    expect(minSpeed).toBeGreaterThan(0);
    expect(maxSpeed).toBeLessThan(1.6);
  });
});

describe("crossingsAlongLoop", () => {
  // a straight east-west loop, one vertex every ~7.8 m, one second per step
  const N = 80;
  const CROSS = 40;
  const probed = (): PreparedRun => {
    const coords: [number, number][] = [];
    const times: number[] = [];
    for (let i = 0; i < N; i++) {
      coords.push([9.18 + i * 0.0001, 45.5]);
      times.push(i);
    }
    return { t0: 0, t1: N - 1, coords, times };
  };

  it("keeps a crossing on the loop with its bump widths", () => {
    const run = probed();
    const keys = new Set([
      coordKey(run.coords[CROSS][0], run.coords[CROSS][1]),
    ]);
    const found = crossingsAlongLoop([run], keys);
    expect(found).toHaveLength(1);
    expect(found[0].t).toBe(CROSS);
    expect(found[0].axis).toBe(0);
    // ~7.8 m per second, so 60 m is ~7.7 s and 255 m is ~32.7 s
    expect(found[0].brake).toBeGreaterThan(7);
    expect(found[0].brake).toBeLessThan(8.5);
    // the recovery covers CROSSING_RECOVER_M/CROSSING_BRAKE_M times the braking
    // distance (same local speed)
    expect(found[0].recover).toBeCloseTo(
      (found[0].brake * CROSSING_RECOVER_M) / CROSSING_BRAKE_M,
      0,
    );
    expect(found[0].recover).toBeGreaterThan(found[0].brake);
  });

  it("ignores points that are not on the loop", () => {
    const run = probed();
    const keys = new Set([coordKey(9.5, 45.9)]);
    expect(crossingsAlongLoop([run], keys)).toEqual([]);
  });

  it("merges crossings closer than the minimum gap", () => {
    const run = probed();
    // two vertices ~8 m apart, well inside CROSSING_MIN_GAP_M
    const keys = new Set([
      coordKey(run.coords[CROSS][0], run.coords[CROSS][1]),
      coordKey(run.coords[CROSS + 1][0], run.coords[CROSS + 1][1]),
    ]);
    expect(crossingsAlongLoop([run], keys)).toHaveLength(1);
  });

  it("handles a crossing at the first vertex (no neighbour behind)", () => {
    const run = probed();
    const keys = new Set([coordKey(run.coords[0][0], run.coords[0][1])]);
    const found = crossingsAlongLoop([run], keys);
    expect(found).toHaveLength(1);
    // no geometry behind it, so the braking side collapses
    expect(found[0].brake).toBe(0);
    expect(found[0].recover).toBeGreaterThan(10);
  });
});
