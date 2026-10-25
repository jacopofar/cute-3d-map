import { describe, expect, it } from "vitest";

import {
  PITCH_MARGIN,
  pitchFrame,
  pitchPaint,
  pitchPoint,
  pitchSportOf,
} from "./pitch_layout";

// an axis-aligned rectangle, the way OSM usually maps a pitch
function box(width: number, height: number): [number, number][] {
  return [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
    [0, 0],
  ];
}

describe("pitchSportOf", () => {
  it("takes the first sport it can paint", () => {
    expect(pitchSportOf("soccer")).toBe("soccer");
    expect(pitchSportOf("Soccer")).toBe("soccer");
    expect(pitchSportOf("rugby;soccer")).toBe("soccer");
    expect(pitchSportOf("tennis;basketball")).toBe("tennis");
  });

  it("ignores sports it has no layout for, and rubbish", () => {
    expect(pitchSportOf("rugby")).toBeNull();
    expect(pitchSportOf("")).toBeNull();
    expect(pitchSportOf(undefined)).toBeNull();
    expect(pitchSportOf(42)).toBeNull();
  });
});

describe("pitchFrame", () => {
  it("scales the real field into the footprint, leaving the margin", () => {
    // 60 x 40 m footprint, soccer proportions 105 x 68: the length is the
    // tighter of the two, so it sets the scale and the width is left short
    const frame = pitchFrame(box(60, 40), "soccer");
    expect(frame).not.toBeNull();
    expect(frame!.length).toBe(105);
    expect(frame!.width).toBe(68);
    expect(frame!.scale).toBeCloseTo((60 - 2 * PITCH_MARGIN) / 105, 6);
    // centred on the footprint
    expect(frame!.centre[0]).toBeCloseTo(30, 6);
    expect(frame!.centre[1]).toBeCloseTo(20, 6);
  });

  it("aligns to the long axis of a rotated court", () => {
    // a tennis court at 90 degrees: 30 m tall, 12 m wide
    const frame = pitchFrame(box(12, 30), "tennis");
    expect(frame).not.toBeNull();
    // the principal axis points up the page, so "along" is +y
    expect(Math.abs(frame!.along[1])).toBeCloseTo(1, 6);
    expect(Math.abs(frame!.across[0])).toBeCloseTo(1, 6);
    // the court's length follows that axis, and here the 12 m side is the
    // tighter fit, so it sets the scale
    expect(frame!.scale).toBeCloseTo((12 - 2 * PITCH_MARGIN) / 10.97, 6);
  });

  it("refuses a footprint too small to be a pitch", () => {
    expect(pitchFrame(box(1, 1), "soccer")).toBeNull();
    expect(pitchFrame(box(40, 30), "rugby")).toBeNull();
    expect(
      pitchFrame(
        [
          [0, 0],
          [1, 0],
        ],
        "soccer",
      ),
    ).toBeNull();
  });
});

describe("pitchPoint", () => {
  it("maps field metres onto the aligned frame", () => {
    const frame = pitchFrame(box(100, 70), "soccer")!;
    const centre = pitchPoint(frame, 0, 0);
    expect(centre[0]).toBeCloseTo(50, 6);
    expect(centre[1]).toBeCloseTo(35, 6);
    // half a field down the length, in model meters
    const end = pitchPoint(frame, frame.length / 2, 0);
    expect(end[0]).toBeCloseTo(50 + (frame.length / 2) * frame.scale, 6);
  });
});

describe("pitchPaint", () => {
  const frame = (sport: string) => pitchFrame(box(120, 80), sport)!;

  it("always draws the outer line", () => {
    const soccer = pitchPaint("soccer", frame("soccer"));
    // the four sides of the field come first
    expect(soccer.slice(0, 4)).toHaveLength(4);
  });

  it("draws a halfway line and a centre circle for soccer", () => {
    const paint = pitchPaint("soccer", frame("soccer"));
    // 4 sides + halfway + 24 circle segments + 2 penalty areas + 2 goal areas
    expect(paint.length).toBe(4 + 1 + 24 + 2 * 4 + 2 * 4);
  });

  it("draws the service boxes and the net line for tennis", () => {
    const paint = pitchPaint("tennis", frame("tennis"));
    // 4 sides + 2 singles sidelines + 2 service lines + centre + net line
    expect(paint.length).toBe(4 + 2 + 2 + 1 + 1);
  });

  it("draws keys, free-throw circles and three-point lines for basketball", () => {
    const paint = pitchPaint("basketball", frame("basketball"));
    // 4 sides + halfway + centre circle + per end: key (4) + circle (16) +
    // two straights + arc (16)
    expect(paint.length).toBe(4 + 1 + 24 + 2 * (4 + 16 + 2 + 16));
  });

  it("draws the centre and attack lines for volleyball", () => {
    const paint = pitchPaint("volleyball", frame("volleyball"));
    expect(paint.length).toBe(4 + 3);
  });

  it("keeps every marking inside the field's outer line", () => {
    for (const sport of ["soccer", "tennis", "basketball", "volleyball"]) {
      const f = frame(sport);
      const paint = pitchPaint(sport, f);
      const halfLength = (f.length / 2) * f.scale + 0.001;
      const halfWidth = (f.width / 2) * f.scale + 0.001;
      for (const segment of paint) {
        for (const point of [segment.a, segment.b]) {
          const du =
            (point[0] - f.centre[0]) * f.along[0] +
            (point[1] - f.centre[1]) * f.along[1];
          const dv =
            (point[0] - f.centre[0]) * f.across[0] +
            (point[1] - f.centre[1]) * f.across[1];
          expect(Math.abs(du)).toBeLessThanOrEqual(halfLength);
          expect(Math.abs(dv)).toBeLessThanOrEqual(halfWidth);
        }
      }
    }
  });
});
