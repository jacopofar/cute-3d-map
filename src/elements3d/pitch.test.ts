import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../projection";
import { pitch } from "./pitch";

const ORIGIN: [number, number] = [9.18, 45.5];
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);

// a lon/lat rectangle, `width` meters across and `height` up the page
function pitchFeature(
  sport: string | undefined,
  width = 60,
  height = 40,
): Geojson.Feature {
  const degPerMeter = 1 / (111_320 * SCALE);
  const latDegPerMeter = 1 / 111_320;
  const x0 = ORIGIN[0] - (width / 2) * degPerMeter;
  const x1 = ORIGIN[0] + (width / 2) * degPerMeter;
  const y0 = ORIGIN[1] - (height / 2) * latDegPerMeter;
  const y1 = ORIGIN[1] + (height / 2) * latDegPerMeter;
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
          [x0, y0],
        ],
      ],
    },
    properties: { cmtype: "green", green: "grass", sport },
  } as unknown as Geojson.Feature;
}

// a 400 m track as OSM maps it: the tartan ring with the infield as a hole
function trackFeature(): Geojson.Feature {
  const offset = (x: number, y: number): [number, number] => [
    ORIGIN[0] + x / (111_320 * SCALE),
    ORIGIN[1] + y / 111_320,
  ];
  // a stadium ring: two straights and a half circle at each end
  const ring = (halfLength: number, radius: number) => {
    const straight = halfLength - radius;
    const points: [number, number][] = [];
    for (const centre of [straight, -straight]) {
      for (let i = 0; i <= 12; i++) {
        const sweep =
          (centre > 0 ? -1 : 1) * (Math.PI / 2) + (i / 12) * Math.PI;
        points.push(
          offset(centre + Math.cos(sweep) * radius, Math.sin(sweep) * radius),
        );
      }
    }
    points.push(points[0]);
    return points;
  };
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [ring(88.5, 46.2), ring(78.7, 36.5)],
    },
    properties: { cmtype: "green", green: "track", sport: "athletics" },
  } as unknown as Geojson.Feature;
}

describe("pitch", () => {
  it("gives a soccer pitch paint and a goal frame, but no surface tint", () => {
    const { surface, paint } = pitch(
      ORIGIN_METERS,
      SCALE,
      pitchFeature("soccer"),
    );
    // grass is already the green layer's color, so only the goals are a mesh
    expect(surface).toHaveLength(1);
    expect(paint).toHaveLength(1);
    // two goals of two posts plus a crossbar
    expect(surface[0].getAttribute("position").count).toBe(6 * 6 * 6);
    expect(paint[0].getAttribute("position").count).toBeGreaterThan(0);
  });

  it("paints a court surface for the sports that are not grass", () => {
    for (const sport of [
      "tennis",
      "basketball",
      "volleyball",
      "padel",
      "futsal",
      "beachvolleyball",
      "multi",
    ]) {
      const { surface, paint } = pitch(
        ORIGIN_METERS,
        SCALE,
        pitchFeature(sport),
      );
      expect(surface.length).toBeGreaterThan(0);
      expect(paint).toHaveLength(1);
    }
  });

  it("fills a track's ring with tartan and paints its lanes", () => {
    const { surface, paint } = pitch(ORIGIN_METERS, SCALE, trackFeature());
    expect(surface).toHaveLength(1);
    // the tint is the ring itself, holes and all, not a fitted rectangle: a
    // rectangle would cover the grass infield
    expect(surface[0].getAttribute("position").count).toBeGreaterThan(6);
    expect(paint[0].getAttribute("position").count).toBeGreaterThan(0);
  });

  it("refuses an athletics area too small to be a track", () => {
    const { surface, paint } = pitch(
      ORIGIN_METERS,
      SCALE,
      pitchFeature("athletics", 40, 30),
    );
    expect(surface).toHaveLength(0);
    expect(paint).toHaveLength(0);
  });

  it("raises rugby goal posts and leaves baseball to the paint", () => {
    const rugby = pitch(ORIGIN_METERS, SCALE, pitchFeature("rugby_union"));
    // the two H frames are meshes; the pitch itself is grass
    expect(rugby.surface).toHaveLength(1);
    expect(rugby.paint).toHaveLength(1);

    const baseball = pitch(
      ORIGIN_METERS,
      SCALE,
      pitchFeature("baseball", 120, 120),
    );
    // a diamond is grass with white lines: no surface of its own
    expect(baseball.surface).toHaveLength(0);
    expect(baseball.paint).toHaveLength(1);
  });

  it("merges a whole tile's worth of parts, which is how the layer draws it", () => {
    for (const sport of [
      "soccer",
      "tennis",
      "basketball",
      "volleyball",
      "padel",
      "futsal",
      "beachvolleyball",
      "multi",
      "rugby_union",
    ]) {
      const { surface } = pitch(ORIGIN_METERS, SCALE, pitchFeature(sport));
      // a mismatch in the attribute sets would return null here, and the tile
      // pass would silently drop the whole kind
      const merged = BufferGeometryUtils.mergeGeometries(surface);
      expect(merged).not.toBeNull();
    }
  });

  it("keeps a green that is not a pitch, or a sport it cannot draw, plain", () => {
    for (const sport of [undefined, "hockey", "cricket", "handball", null]) {
      const { surface, paint } = pitch(
        ORIGIN_METERS,
        SCALE,
        pitchFeature(sport as string | undefined),
      );
      expect(surface).toHaveLength(0);
      expect(paint).toHaveLength(0);
    }
  });

  it("faces the court up whichever way the ring was wound", () => {
    // OSM rings come in both windings; a quad wound the wrong way faces down
    // and the court disappears under its own lawn
    for (const reversed of [false, true]) {
      const f = pitchFeature("tennis");
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
      if (reversed) ring.reverse();
      const { surface } = pitch(ORIGIN_METERS, SCALE, f);
      const pos = surface[0].getAttribute("position");
      // the first two triangles are the tint quad; the net follows
      for (const tri of [0, 3]) {
        const ax = pos.getX(tri);
        const ay = pos.getY(tri);
        const bx = pos.getX(tri + 1);
        const by = pos.getY(tri + 1);
        const cx = pos.getX(tri + 2);
        const cy = pos.getY(tri + 2);
        const cross = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
        expect(cross).toBeGreaterThan(0);
      }
    }
  });

  it("refuses a footprint too small to lay a field on", () => {
    const { surface, paint } = pitch(
      ORIGIN_METERS,
      SCALE,
      pitchFeature("soccer", 2, 2),
    );
    expect(surface).toHaveLength(0);
    expect(paint).toHaveLength(0);
  });
});
