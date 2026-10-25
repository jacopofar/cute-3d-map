import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../projection";
import { roadMarking } from "./road_marking";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(properties: Record<string, unknown>): Geojson.Feature {
  return {
    type: "Feature",
    id: "node/1",
    properties,
    geometry: { type: "Point", coordinates: [9.19, 45.46] },
  };
}

const base = {
  cmtype: "road_marking",
  kind: "signal",
  width: 12,
  lanes: 4,
  oneway: "no",
  turn_lanes: "left|through",
};

describe("roadMarking", () => {
  it("builds two stop lines and four lane arrows at a two-way junction", () => {
    const built = roadMarking(
      ORIGIN_METERS,
      SCALE,
      feature({ ...base, directions: [0, 180] }),
    );
    expect(built).toHaveLength(1);
    const geometry = built[0];
    const position = geometry.getAttribute("position");
    expect(position.count).toBeGreaterThan(60);
    for (const name of ["normal", "uv", "color"]) {
      expect(geometry.getAttribute(name).count).toBe(position.count);
    }
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.z).toBeCloseTo(0.048, 5);
  });

  it("keeps a single-lane approach to one stop line and no arrows", () => {
    const built = roadMarking(
      ORIGIN_METERS,
      SCALE,
      feature({
        ...base,
        directions: [0],
        oneway: "yes",
        lanes: 1,
        turn_lanes: undefined,
      }),
    );
    expect(built[0].getAttribute("position").count).toBe(12);
  });

  it("breaks a give-way line into dashes", () => {
    const solid = roadMarking(
      ORIGIN_METERS,
      SCALE,
      feature({ ...base, directions: [0], lanes: 1, oneway: "yes" }),
    )[0];
    const dashed = roadMarking(
      ORIGIN_METERS,
      SCALE,
      feature({
        ...base,
        kind: "give_way",
        directions: [0],
        lanes: 1,
        oneway: "yes",
      }),
    )[0];
    expect(dashed.getAttribute("position").count).toBeGreaterThan(
      solid.getAttribute("position").count,
    );
  });

  it("winds every triangle counter-clockwise from above", () => {
    const built = roadMarking(
      ORIGIN_METERS,
      SCALE,
      feature({ ...base, directions: [20, 200] }),
    )[0];
    const pos = built.getAttribute("position");
    for (let i = 0; i < pos.count; i += 3) {
      const ax = pos.getX(i),
        ay = pos.getY(i);
      const bx = pos.getX(i + 1),
        by = pos.getY(i + 1);
      const cx = pos.getX(i + 2),
        cy = pos.getY(i + 2);
      expect((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)).toBeGreaterThan(0);
    }
  });

  it("skips a node with no approach direction", () => {
    expect(roadMarking(ORIGIN_METERS, SCALE, feature(base))).toEqual([]);
  });
});

describe("turn-lane paint", () => {
  // bearing 0 is north: "before the node" is negative y in model space
  const approachNorth = (lanes: number, oneway: string) =>
    roadMarking(
      ORIGIN_METERS,
      SCALE,
      feature({
        cmtype: "road_marking",
        kind: "signal",
        directions: [0],
        width: 3.5 * lanes,
        lanes,
        oneway,
        turn_lanes: undefined,
      }),
    )[0];

  it("paints the pocket from the stop line back along the approach", () => {
    const geometry = approachNorth(2, "yes");
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    // 3.2 m to the stop line, then the 22 m pocket, plus the outline
    expect(box.min.y).toBeCloseTo(-(3.2 + 22 + 0.06), 0);
    // and the paint stops at the stop line, not at the node
    expect(box.max.y).toBeCloseTo(-3.2 + 0.31, 0);
  });

  it("puts the separators on the lane boundaries", () => {
    // four lanes one way: three boundaries, at -1, 0 and +1 lane widths from
    // the centre
    const single = approachNorth(1, "yes");
    single.computeBoundingBox();
    const narrow = single.boundingBox!;
    const four = approachNorth(4, "yes");
    four.computeBoundingBox();
    const wide = four.boundingBox!;

    // one lane has only the stop line, so its span is the line's thickness
    expect(narrow.max.x - narrow.min.x).toBeCloseTo(3.5 + 2 * 0.06, 0);
    // ... while four lanes paint out to the outer boundaries
    expect(wide.max.x - wide.min.x).toBeCloseTo(
      3.5 * 4 + 2 * 0.06 + 2 * 0.08,
      0,
    );
  });
});
