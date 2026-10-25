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
