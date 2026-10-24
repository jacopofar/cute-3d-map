import { describe, expect, it } from "vitest";

import {
  DRIVE_CONFIG,
  MAX_DRIVE_FRAME,
  driveStep,
  headingFromBearing,
  headingToBearing,
  pointAhead,
  type DriveInput,
  type DriveState,
} from "./driving";

const NONE: DriveInput = {
  forward: false,
  backward: false,
  left: false,
  right: false,
};

const rest: DriveState = { lon: 9, lat: 45, heading: 0, speed: 0 };

const at = (over: Partial<DriveState>): DriveState => ({ ...rest, ...over });

describe("driving model", () => {
  it("accelerates along the heading and caps at the max speed", () => {
    const config = { ...DRIVE_CONFIG, maxSpeed: 10, acceleration: 50 };
    const moved = driveStep(rest, { ...NONE, forward: true }, 0.1, config);
    expect(moved.speed).toBe(5);
    // heading 0 is east, so only the longitude changes
    expect(moved.lon).toBeGreaterThan(rest.lon);
    expect(moved.lat).toBeCloseTo(rest.lat, 10);

    const capped = driveStep(
      at({ speed: 9.5 }),
      { ...NONE, forward: true },
      0.1,
      config,
    );
    expect(capped.speed).toBe(10);
  });

  it("drives north at a quarter-turn heading", () => {
    const config = { ...DRIVE_CONFIG, coast: 0 };
    const moved = driveStep(
      at({ heading: Math.PI / 2, speed: 10 }),
      NONE,
      0.1,
      config,
    );
    expect(moved.lon).toBeCloseTo(9, 10);
    expect(moved.lat - 45).toBeCloseTo(1 / 111_320, 10);
  });

  it("coasts to a stop and caps a stalled frame", () => {
    const config = { ...DRIVE_CONFIG, coast: 5 };
    const coasted = driveStep(at({ speed: 10 }), NONE, 0.1, config);
    expect(coasted.speed).toBeCloseTo(9.5);

    const stopped = driveStep(at({ speed: 0.1 }), NONE, 0.1, config);
    expect(stopped.speed).toBe(0);

    const long = driveStep(
      at({ heading: Math.PI / 2, speed: 10 }),
      NONE,
      5,
      config,
    );
    const capped = driveStep(
      at({ heading: Math.PI / 2, speed: 10 }),
      NONE,
      MAX_DRIVE_FRAME,
      config,
    );
    expect(long.speed).toBeCloseTo(capped.speed);
    expect(long.lat).toBeCloseTo(capped.lat, 12);
  });

  it("keeps real-time motion when a frame needs substeps", () => {
    const config = { ...DRIVE_CONFIG, coast: 0 };
    const moved = driveStep(
      at({ heading: Math.PI / 2, speed: 10 }),
      NONE,
      0.4,
      config,
    );
    // 0.4 s at 10 m/s even though one physics step is at most 0.1 s
    expect(moved.lat - 45).toBeCloseTo(4 / 111_320, 10);
  });

  it("brakes a forward car before reversing it", () => {
    const config = {
      ...DRIVE_CONFIG,
      braking: 10,
      acceleration: 2,
      maxReverse: 5,
    };
    const braked = driveStep(
      at({ speed: 4 }),
      { ...NONE, backward: true },
      0.1,
      config,
    );
    expect(braked.speed).toBeCloseTo(3);

    const reverse = driveStep(
      at({ speed: 0 }),
      { ...NONE, backward: true },
      0.1,
      config,
    );
    expect(reverse.speed).toBeCloseTo(-0.2);
  });

  it("turns only while moving and flips the wheel when reversing", () => {
    const config = {
      ...DRIVE_CONFIG,
      steerRate: 1,
      fullSteerSpeed: 1,
      coast: 0,
    };
    const left = driveStep(
      at({ heading: 0, speed: 10 }),
      { ...NONE, left: true },
      0.1,
      config,
    );
    expect(left.heading).toBeCloseTo(0.1);

    const right = driveStep(
      at({ heading: 0, speed: 10 }),
      { ...NONE, right: true },
      0.1,
      config,
    );
    expect(right.heading).toBeCloseTo(Math.PI * 2 - 0.1);

    const parked = driveStep(
      at({ heading: 0, speed: 0 }),
      { ...NONE, left: true },
      0.1,
      config,
    );
    expect(parked.heading).toBe(0);

    const reversing = driveStep(
      at({ heading: 0, speed: -10 }),
      { ...NONE, right: true },
      0.1,
      config,
    );
    expect(reversing.heading).toBeCloseTo(0.1);
  });

  it("converts between heading and map bearing", () => {
    expect(headingToBearing(Math.PI / 2)).toBeCloseTo(0);
    expect(headingToBearing(0)).toBeCloseTo(90);
    expect(headingToBearing(-Math.PI / 2)).toBeCloseTo(180);
    expect(headingToBearing(Math.PI * 2)).toBeCloseTo(90);

    expect(headingFromBearing(0)).toBeCloseTo(Math.PI / 2);
    expect(headingFromBearing(90)).toBeCloseTo(0);
    expect(headingFromBearing(180)).toBeCloseTo((Math.PI * 3) / 2);
  });

  it("steps a point along the heading", () => {
    const [eastLon, eastLat] = pointAhead(9, 45, 0, 100);
    expect(eastLon).toBeGreaterThan(9);
    expect(eastLat).toBeCloseTo(45, 10);

    const [northLon, northLat] = pointAhead(9, 45, Math.PI / 2, 100);
    expect(northLon).toBeCloseTo(9, 10);
    expect(northLat - 45).toBeCloseTo(100 / 111_320, 10);
  });

  it("stops before a blocked obstacle", () => {
    const wall = 9.0001;
    const blocked = (state: DriveState) => state.lon > wall;
    const config = { ...DRIVE_CONFIG, coast: 0 };
    let state = at({ lon: 9, lat: 45, heading: 0, speed: 10 });
    for (let i = 0; i < 30; i++) {
      state = driveStep(state, NONE, 0.1, config, blocked);
    }
    expect(state.lon).toBeLessThanOrEqual(wall);
    expect(state.speed).toBe(0);
  });

  it("slides along a blocked axis instead of sticking", () => {
    // a wall just to the north; the diagonal candidate crosses it, the
    // east-only step does not
    const blocked = (state: DriveState) => state.lat > 45.000005;
    const config = { ...DRIVE_CONFIG, coast: 0 };
    const start = at({ lon: 9, lat: 45, heading: Math.PI / 4, speed: 10 });
    const moved = driveStep(start, NONE, 0.1, config, blocked);
    expect(moved.lon).toBeGreaterThan(9);
    expect(moved.lat).toBeCloseTo(45, 12);
    expect(moved.speed).toBe(10);
  });

  it("lets an already-overlapping car drive out", () => {
    // the start is inside the blocked half-plane, so moving must not be
    // refused: otherwise a bad spawn would trap the car forever
    const blocked = (state: DriveState) => state.lon > 9.00002;
    const start = at({ lon: 9.00003, lat: 45, heading: Math.PI / 2, speed: 5 });
    const moved = driveStep(
      start,
      NONE,
      0.1,
      { ...DRIVE_CONFIG, coast: 0 },
      blocked,
    );
    expect(moved.lat).toBeGreaterThan(45);
  });
});
