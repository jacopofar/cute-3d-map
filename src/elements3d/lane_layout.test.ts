import { describe, expect, it } from "vitest";

import {
  DASH_GAP,
  DASH_LENGTH,
  dashes,
  dividers,
  offsetLine,
  solid,
} from "./lane_layout";

describe("dividers", () => {
  it("gives a one-way road one dashed edge per lane boundary", () => {
    const out = dividers(9, 4, true);
    expect(out).toHaveLength(3);
    expect(out.every((d) => d.dashed)).toBe(true);
    // evenly spread across the carriageway, inside its edges
    expect(out.map((d) => d.offset)).toEqual([-2.25, 0, 2.25]);
  });

  it("gives a two-way road a solid centre and dashed edges per direction", () => {
    const two = dividers(8, 2, false);
    expect(two).toEqual([{ offset: 0, dashed: false }]);

    const four = dividers(12, 4, false);
    expect(four[0]).toEqual({ offset: 0, dashed: false });
    expect(four.slice(1).map((d) => d.offset)).toEqual([3, -3]);
    expect(four.slice(1).every((d) => d.dashed)).toBe(true);
  });

  it("draws nothing for a single lane or a nonsense width", () => {
    expect(dividers(7, 1, true)).toEqual([]);
    expect(dividers(0, 4, true)).toEqual([]);
    expect(dividers(7, 0, false)).toEqual([]);
  });
});

describe("offsetLine", () => {
  it("shifts a straight line sideways by the offset", () => {
    // heading east: positive is to the left of travel, so +y
    const out = offsetLine(
      [
        [0, 0],
        [10, 0],
      ],
      2,
    );
    expect(out).toEqual([
      [0, 2],
      [10, 2],
    ]);
  });

  it("leaves the line alone at offset zero and keeps the vertex count", () => {
    const line: [number, number][] = [
      [0, 0],
      [5, 5],
      [10, 0],
    ];
    expect(offsetLine(line, 0)).toEqual(line);
    expect(offsetLine(line, 1)).toHaveLength(3);
  });
});

describe("dashes", () => {
  it("cuts a straight line into dash and gap runs", () => {
    const out = dashes(
      [
        [0, 0],
        [30, 0],
      ],
      DASH_LENGTH,
      DASH_GAP,
    );
    // 3 m dash, 6 m gap, 9 m period: 0-3, 9-12, 18-21, 27-30
    expect(out.map((s) => [s.a[0], s.b[0]])).toEqual([
      [0, 3],
      [9, 12],
      [18, 21],
      [27, 30],
    ]);
    expect(out.every((s) => s.a[1] === 0 && s.b[1] === 0)).toBe(true);
  });

  it("carries the dash phase across a vertex", () => {
    // two 12 m legs at a right angle: the pattern must not restart at the corner
    const out = dashes(
      [
        [0, 0],
        [12, 0],
        [12, 12],
      ],
      DASH_LENGTH,
      DASH_GAP,
    );
    // dashes sit at 0-3, 9-12, 18-21 m of travel. The first leg ends at 12 m
    // (a gap runs 12-18), so the corner does not restart the pattern: the
    // second leg gets one dash, 6 m in, instead of one starting at the corner
    expect(out.map((s) => [s.a, s.b])).toEqual([
      [
        [0, 0],
        [3, 0],
      ],
      [
        [9, 0],
        [12, 0],
      ],
      [
        [12, 6],
        [12, 9],
      ],
    ]);
  });

  it("drops a speck of a dash at the end of a clipped line", () => {
    const out = dashes(
      [
        [0, 0],
        [3.2, 0],
      ],
      3,
      6,
    );
    // the first dash is exactly the dash length; the 0.2 m remainder is not a
    // second dash
    expect(out).toHaveLength(1);
  });
});

describe("solid", () => {
  it("is one segment per polyline edge", () => {
    const out = solid([
      [0, 0],
      [5, 0],
      [5, 5],
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ a: [0, 0], b: [5, 0] });
  });
});
