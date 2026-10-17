import { describe, expect, it } from "vitest";

import {
  BALCONY_MAX_WIDTH,
  BALCONY_MIN_WIDTH,
  DOOR_WIDTH,
  GROUND_CLEARANCE,
  MAX_FLOORS,
  ROOF_MARGIN,
  WINDOW_HEIGHT,
  WINDOW_MARGIN,
  WINDOW_MAX_WIDTH,
  WINDOW_MIN_WIDTH,
  balconyBands,
  balconyColumn,
  balconySpan,
  doorSpan,
  facadeWindows,
  floorBands,
  hashSeed,
  makeRng,
} from "./facade_layout";

describe("makeRng", () => {
  it("is deterministic for a seed and differs between seeds", () => {
    const a = Array.from({ length: 5 }, makeRng(42));
    const b = Array.from({ length: 5 }, makeRng(42));
    const c = Array.from({ length: 5 }, makeRng(43));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("hashSeed", () => {
  it("is stable and position-dependent", () => {
    expect(hashSeed("9.18,45.5")).toBe(hashSeed("9.18,45.5"));
    expect(hashSeed("9.18,45.5")).not.toBe(hashSeed("9.18,45.6"));
  });
});

describe("facadeWindows", () => {
  const check = (length: number, seed: number) => {
    const spans = facadeWindows(length, makeRng(seed));
    let previousEnd = 0;
    for (const span of spans) {
      expect(span.start).toBeGreaterThanOrEqual(WINDOW_MARGIN);
      expect(span.start + span.width).toBeLessThanOrEqual(
        length - WINDOW_MARGIN,
      );
      expect(span.width).toBeGreaterThanOrEqual(WINDOW_MIN_WIDTH);
      expect(span.width).toBeLessThanOrEqual(WINDOW_MAX_WIDTH);
      expect(span.start).toBeGreaterThan(previousEnd); // sorted, no overlap
      previousEnd = span.start + span.width;
    }
    return spans;
  };

  it("lays out windows inside the facade with a margin", () => {
    const spans = check(20, 1);
    expect(spans.length).toBeGreaterThan(1);
  });

  it("is deterministic for the same seed", () => {
    expect(facadeWindows(20, makeRng(7))).toEqual(
      facadeWindows(20, makeRng(7)),
    );
  });

  it("yields nothing for a facade too short for a window", () => {
    expect(facadeWindows(2 * WINDOW_MARGIN, makeRng(1))).toEqual([]);
  });

  it("fills a long facade rather than stopping part-way", () => {
    // the old column cap left the far half of a long facade bare
    const length = 90;
    const spans = check(length, 11);
    expect(spans.length).toBeGreaterThan(25);
    const last = spans[spans.length - 1];
    expect(last.start + last.width).toBeGreaterThan(length * 0.75);
  });
});

describe("floorBands", () => {
  it("stacks bands from the ground without poking through the roof", () => {
    const height = 24;
    const bands = floorBands(height, makeRng(5));
    expect(bands.length).toBeGreaterThan(3);
    expect(bands[0].start).toBe(GROUND_CLEARANCE);
    for (let i = 0; i < bands.length; i++) {
      expect(bands[i].width).toBe(WINDOW_HEIGHT);
      expect(bands[i].start + bands[i].width).toBeLessThanOrEqual(
        height - ROOF_MARGIN,
      );
      if (i > 0) expect(bands[i].start).toBeGreaterThan(bands[i - 1].start);
    }
  });

  it("yields nothing for a low building", () => {
    // ground clearance + window height is already past the roof
    expect(floorBands(GROUND_CLEARANCE + WINDOW_HEIGHT, makeRng(1))).toEqual(
      [],
    );
  });

  it("caps the number of floors", () => {
    expect(floorBands(1000, makeRng(1)).length).toBeLessThanOrEqual(MAX_FLOORS);
  });
});

describe("doorSpan", () => {
  it("centres a door on a facade wide enough", () => {
    const span = doorSpan(10);
    expect(span).not.toBeNull();
    expect(span!.width).toBe(DOOR_WIDTH);
    expect(span!.start + span!.width / 2).toBeCloseTo(5);
  });

  it("yields nothing on a facade too narrow", () => {
    expect(doorSpan(DOOR_WIDTH)).toBeNull();
  });
});

describe("balconyBands", () => {
  const bands = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ start: 1 + i * 3, width: 1.6 }));

  it("has no floors below two floors", () => {
    expect(balconyBands([])).toEqual([]);
    expect(balconyBands(bands(1))).toEqual([]);
  });

  it("is the floors above the ground", () => {
    expect(balconyBands(bands(4))).toEqual([1, 2, 3]);
  });
});

describe("balconyColumn", () => {
  const floors = [1, 2, 3, 4];

  it("usually gives the whole column (or nothing), rarely a partial one", () => {
    let full = 0;
    let empty = 0;
    let partial = 0;
    for (let seed = 0; seed < 600; seed++) {
      const result = balconyColumn(floors, makeRng(seed));
      if (result.length === 0) empty++;
      else if (result.length === floors.length) full++;
      else partial++;
    }
    expect(full).toBeGreaterThan(0);
    expect(empty).toBeGreaterThan(0);
    // the aligned cases dominate; the irregular ones are the minority
    expect(partial).toBeLessThan(0.2 * 600);
    expect(partial).toBeLessThan(full);
  });

  it("is empty when there are no eligible floors", () => {
    expect(balconyColumn([], makeRng(1))).toEqual([]);
  });
});

describe("balconySpan", () => {
  it("centres a seeded width on the column", () => {
    const column = { start: 5, width: 1.2 };
    const span = balconySpan(column, 20, makeRng(1));
    expect(span.width).toBeGreaterThanOrEqual(BALCONY_MIN_WIDTH);
    expect(span.width).toBeLessThanOrEqual(BALCONY_MAX_WIDTH);
    expect(span.start + span.width / 2).toBeCloseTo(
      column.start + column.width / 2,
    );
  });

  it("pulls a balcony back inside the facade margin", () => {
    const span = balconySpan({ start: 19.5, width: 1 }, 20, makeRng(1));
    expect(span.start).toBeGreaterThanOrEqual(WINDOW_MARGIN);
    expect(span.start + span.width).toBeLessThanOrEqual(20 - WINDOW_MARGIN);
  });
});
