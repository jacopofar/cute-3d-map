import { describe, expect, it } from "vitest";

import {
  FLAT_AREA,
  GABLE_ASPECT,
  MAX_RISE,
  MIN_RISE,
  PYRAMID_WIDTH,
  ROOF_KINDS,
  chooseRoofKind,
  frameToWorld,
  polygonArea,
  ridgeAxis,
  ridgeExtent,
  isConvex,
  MAX_ROOF_VERTICES,
  ringCorners,
  roofOutline,
  roofFrame,
  roofPlan,
  roofRise,
} from "./roof_layout";

// a 10 m x 4 m rectangle, long side east
const rectangle: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 4],
  [0, 4],
];
// never triggers the seeded "variety" branch (ROOF_VARIETY is well below 0.9)
const steady = () => 0.9;

describe("polygonArea", () => {
  it("measures a rectangle either winding", () => {
    expect(polygonArea(rectangle)).toBeCloseTo(40);
    expect(polygonArea([...rectangle].reverse())).toBeCloseTo(40);
  });
});

describe("ridgeAxis", () => {
  it("follows the longest edge", () => {
    expect(ridgeAxis(rectangle)).toEqual([1, 0]);
  });
});

describe("roofFrame", () => {
  it("measures the footprint along and across the ridge", () => {
    const frame = roofFrame(rectangle);
    expect(frame.alongMin).toBeCloseTo(0);
    expect(frame.alongMax).toBeCloseTo(10);
    expect(frame.acrossCentre).toBeCloseTo(2);
    expect(frame.width).toBeCloseTo(4);
  });

  it("maps frame coordinates back to the footprint", () => {
    const frame = roofFrame(rectangle);
    // along the ridge and centred across it: the middle of the rectangle
    expect(frameToWorld(frame, 5, frame.acrossCentre)).toEqual([5, 2]);
  });
});

describe("chooseRoofKind", () => {
  it("gables a long, narrow footprint", () => {
    const length = 12;
    const width = 12 / (GABLE_ASPECT + 0.5);
    expect(chooseRoofKind(length, width, length * width, steady)).toBe(
      "gabled",
    );
  });

  it("keeps a big block flat", () => {
    const side = Math.sqrt(FLAT_AREA) + 4;
    expect(chooseRoofKind(side, side, side * side, steady)).toBe("flat");
  });

  it("pyramids a small squarish footprint", () => {
    const side = PYRAMID_WIDTH - 1;
    expect(chooseRoofKind(side, side, side * side, steady)).toBe("pyramidal");
  });

  it("hips the ones in between", () => {
    expect(chooseRoofKind(14, 12, 168, steady)).toBe("hipped");
  });

  it("lets the seeded variety pick any kind", () => {
    // first draw under ROOF_VARIETY takes the surprise branch, then picks
    const kind = chooseRoofKind(12, 4, 48, () => 0.05);
    expect(ROOF_KINDS).toContain(kind);
  });
});

describe("roofRise", () => {
  it("stays within its bounds", () => {
    expect(roofRise(1)).toBe(MIN_RISE);
    expect(roofRise(1000)).toBe(MAX_RISE);
    expect(roofRise(8)).toBeGreaterThan(MIN_RISE);
    expect(roofRise(8)).toBeLessThan(MAX_RISE);
  });
});

describe("ridgeExtent", () => {
  it("reaches both ends for a gable", () => {
    expect(ridgeExtent("gabled", 0, 10, 4)).toEqual([0, 10]);
  });

  it("pulls in for a hip", () => {
    const [min, max] = ridgeExtent("hipped", 0, 10, 4);
    expect(min).toBeGreaterThan(0);
    expect(max).toBeLessThan(10);
    expect(min).toBeCloseTo(2);
  });

  it("collapses to a point for a pyramid", () => {
    expect(ridgeExtent("pyramidal", 0, 10, 4)).toEqual([5, 5]);
  });
});

describe("roofOutline", () => {
  // a 10x10 square with a small dent in the top edge: concave, but barely
  const dented: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [4, 9],
    [0, 10],
  ];
  // a 10x10 square missing a 6x6 corner: a real L, too far from its hull
  const lShape: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 4],
    [4, 4],
    [4, 10],
    [0, 10],
  ];

  it("uses the ring itself when it is convex", () => {
    expect(roofOutline(rectangle)).toBe(rectangle);
  });

  it("gives up on a concave ring, however mild", () => {
    expect(roofOutline(dented)).toBeNull();
  });

  it("gives up on a footprint that is far from convex", () => {
    expect(roofOutline(lShape)).toBeNull();
  });

  it("gives up on a degenerate ring", () => {
    expect(
      roofOutline([
        [0, 0],
        [1, 1],
      ]),
    ).toBeNull();
  });

  it("gives up once the outline has more than MAX_ROOF_VERTICES corners", () => {
    const many: [number, number][] = [];
    for (let i = 0; i <= MAX_ROOF_VERTICES; i++) {
      const a = (2 * Math.PI * i) / (MAX_ROOF_VERTICES + 1);
      many.push([Math.cos(a) * 10, Math.sin(a) * 10]);
    }
    expect(roofOutline(many)).toBeNull();
  });

  it("still roofs an eight-corner convex ring", () => {
    const octagon: [number, number][] = [];
    for (let i = 0; i < MAX_ROOF_VERTICES; i++) {
      const a = (2 * Math.PI * i) / MAX_ROOF_VERTICES;
      octagon.push([Math.cos(a) * 10, Math.sin(a) * 10]);
    }
    expect(roofOutline(octagon)).not.toBeNull();
  });

  it("ignores a repeated closing vertex when counting corners", () => {
    const closed = [...rectangle, rectangle[0]];
    expect(ringCorners(closed)).toBe(4);
    expect(roofOutline(closed)).not.toBeNull();
  });
});

describe("isConvex", () => {
  it("knows a convex ring either winding", () => {
    expect(isConvex(rectangle)).toBe(true);
    expect(isConvex([...rectangle].reverse())).toBe(true);
  });

  it("rejects a concave ring", () => {
    expect(
      isConvex([
        [0, 0],
        [10, 0],
        [10, 4],
        [4, 4],
        [4, 10],
        [0, 10],
      ]),
    ).toBe(false);
  });
});

describe("roofPlan", () => {
  it("plans a gable over a long footprint", () => {
    const roof = roofPlan(rectangle, steady);
    expect(roof).not.toBeNull();
    expect(roof!.kind).toBe("gabled");
    expect(roof!.ridgeMin).toBeCloseTo(0);
    expect(roof!.ridgeMax).toBeCloseTo(10);
    expect(roof!.rise).toBeCloseTo(1.8);
  });

  it("leaves a big square flat", () => {
    const side = Math.sqrt(FLAT_AREA) + 4;
    const square: [number, number][] = [
      [0, 0],
      [side, 0],
      [side, side],
      [0, side],
    ];
    expect(roofPlan(square, steady)).toBeNull();
  });
});
