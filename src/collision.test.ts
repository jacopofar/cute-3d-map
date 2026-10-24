import { describe, expect, it } from "vitest";

import {
  boxOfPoints,
  boxesOverlap,
  carRectangle,
  lineIntersectsRect,
  pointInRing,
  ringIntersectsRect,
  segmentsIntersect,
  type Point,
} from "./collision";

const ringOf = (
  west: number,
  south: number,
  east: number,
  north: number,
): Point[] => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
];

describe("collision geometry", () => {
  it("tests points in a ring", () => {
    const ring = ringOf(0, 0, 2, 2);
    expect(pointInRing(ring, [1, 1])).toBe(true);
    expect(pointInRing(ring, [2.5, 1])).toBe(false);
    expect(pointInRing(ring, [-0.1, 1])).toBe(false);
  });

  it("intersects crossing, touching and collinear segments", () => {
    expect(segmentsIntersect([0, 0], [2, 2], [0, 2], [2, 0])).toBe(true);
    expect(segmentsIntersect([0, 0], [1, 0], [2, 2], [3, 3])).toBe(false);
    expect(segmentsIntersect([0, 0], [2, 0], [1, 0], [3, 0])).toBe(true);
    expect(segmentsIntersect([0, 0], [1, 1], [1, 1], [2, 0])).toBe(true);
  });

  it("computes and overlaps boxes", () => {
    expect(
      boxOfPoints([
        [2, 3],
        [-1, 5],
        [4, -2],
      ]),
    ).toEqual([-1, -2, 4, 5]);
    expect(boxesOverlap([0, 0, 2, 2], [1, 1, 3, 3])).toBe(true);
    expect(boxesOverlap([0, 0, 1, 1], [2, 2, 3, 3])).toBe(false);
    // touching is an overlap
    expect(boxesOverlap([0, 0, 1, 1], [1, 0, 2, 1])).toBe(true);
  });

  it("builds the car rectangle along the heading", () => {
    const east = carRectangle(9, 45, 0, 4, 2);
    // heading 0 points east: the 4 m length runs along longitude and the 2 m
    // width along latitude
    const metersPerLon = 111_320 * Math.cos((45 * Math.PI) / 180);
    expect((east.box[2] - east.box[0]) * metersPerLon).toBeCloseTo(4, 5);
    expect((east.box[3] - east.box[1]) * 111_320).toBeCloseTo(2, 5);
    expect(east.box[0]).toBeLessThan(9);
    expect(east.box[2]).toBeGreaterThan(9);
    expect(east.box[1]).toBeLessThan(45);
    expect(east.box[3]).toBeGreaterThan(45);

    const north = carRectangle(9, 45, Math.PI / 2, 4, 2);
    // heading pi/2 points north: the length runs along latitude
    expect((north.box[3] - north.box[1]) * 111_320).toBeCloseTo(4, 5);
    expect((north.box[2] - north.box[0]) * metersPerLon).toBeCloseTo(2, 5);
  });

  it("grows the car rectangle by the margin", () => {
    const tight = carRectangle(9, 45, 0.7, 4, 2);
    const loose = carRectangle(9, 45, 0.7, 4, 2, 0.5);
    expect(loose.box[2] - loose.box[0]).toBeGreaterThan(
      tight.box[2] - tight.box[0],
    );
    expect(loose.box[3] - loose.box[1]).toBeGreaterThan(
      tight.box[3] - tight.box[1],
    );
  });

  it("detects a building touching the car, not one far away", () => {
    const car = carRectangle(9, 45, 0, 4, 2);
    const [west, south, east, north] = car.box;
    // a footprint around the whole car
    expect(
      ringIntersectsRect(
        ringOf(west - 1e-5, south - 1e-5, east + 1e-5, north + 1e-5),
        car,
      ),
    ).toBe(true);
    // a tiny shed entirely inside the car
    expect(
      ringIntersectsRect(ringOf(9 - 1e-7, 45 - 1e-7, 9 + 1e-7, 45 + 1e-7), car),
    ).toBe(true);
    // a wall crossing the car with no corner contained in it
    expect(
      ringIntersectsRect(
        ringOf(9 - 1e-7, south - 1e-5, 9 + 1e-7, north + 1e-5),
        car,
      ),
    ).toBe(true);
    // a footprint well clear of the car
    expect(
      ringIntersectsRect(
        ringOf(west - 1e-4, south - 1e-4, west - 5e-5, north + 1e-4),
        car,
      ),
    ).toBe(false);
  });

  it("detects fences touching the car", () => {
    const car = carRectangle(9, 45, 0, 4, 2);
    const [west, south, east, north] = car.box;
    // a fence across the car
    expect(
      lineIntersectsRect(
        [
          [9, south - 1e-5],
          [9, north + 1e-5],
        ],
        car,
      ),
    ).toBe(true);
    // a short stub entirely inside the body
    expect(
      lineIntersectsRect(
        [
          [9, 45],
          [9 + 1e-7, 45],
        ],
        car,
      ),
    ).toBe(true);
    // a fence running parallel, just outside the west edge
    expect(
      lineIntersectsRect(
        [
          [west - 1e-5, south - 1e-5],
          [west - 1e-5, north + 1e-5],
        ],
        car,
      ),
    ).toBe(false);
    // an empty line cannot hit anything
    expect(lineIntersectsRect([], car)).toBe(false);
    expect(east).toBeGreaterThan(9);
  });
});
