import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../projection";
import {
  DEFAULT_FENCE_COLOR,
  FENCE_HEIGHT,
  FENCE_PITCH,
  FENCE_POST_WIDTH,
  FENCE_RAILS,
  fence,
  fenceBand,
  fenceColor,
} from "./fence";

const ORIGIN: [number, number] = [9.18, 45.5];
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);

// ~24 m along the x axis
function lineFeature(barrier = "fence"): Geojson.Feature {
  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [ORIGIN[0] - 1.5e-4, ORIGIN[1]],
        [ORIGIN[0] + 1.5e-4, ORIGIN[1]],
      ],
    },
    properties: { cmtype: "fence", barrier },
  } as unknown as Geojson.Feature;
}

const colorOf = (geometry: THREE.BufferGeometry): string =>
  new THREE.Color(
    geometry.getAttribute("color").getX(0),
    geometry.getAttribute("color").getY(0),
    geometry.getAttribute("color").getZ(0),
  ).getHexString();

describe("fence", () => {
  it("stands a band from the ground to the fence height", () => {
    const [geometry] = fence(ORIGIN_METERS, SCALE, lineFeature());
    const position = geometry.getAttribute("position");
    const z = geometry.getAttribute("aZ");
    // one segment -> two triangles -> six vertices
    expect(position.count).toBe(6);
    expect(z.count).toBe(6);
    for (let i = 0; i < position.count; i++) {
      // aZ is 0 at the ground and 1 at the top, so the band is FENCE_HEIGHT tall
      expect(position.getZ(i)).toBeCloseTo(z.getX(i) * FENCE_HEIGHT, 5);
      expect(z.getX(i) === 0 || z.getX(i) === 1).toBe(true);
    }
  });

  it("measures aU as the distance along the fence", () => {
    const [geometry] = fence(ORIGIN_METERS, SCALE, lineFeature());
    const u = geometry.getAttribute("aU");
    const position = geometry.getAttribute("position");
    // vertex 0 is the near base, vertex 5 the far base
    const length = Math.hypot(
      position.getX(5) - position.getX(0),
      position.getY(5) - position.getY(0),
    );
    const values = Array.from({ length: u.count }, (_, i) => u.getX(i));
    expect(Math.min(...values)).toBe(0);
    expect(Math.max(...values)).toBeCloseTo(length, 4);
    // the span covers more than one pitch, so the shader gets several posts
    expect(length / FENCE_PITCH).toBeGreaterThan(1);
  });

  it("accumulates aU across a polyline so the posts stay on pitch", () => {
    const band = fenceBand([
      [0, 0],
      [3, 0],
      [3, 4],
    ]);
    // two segments -> twelve vertices, each pushed exactly twice (base and top)
    expect(band.positions).toHaveLength(6 * 2 * 3);
    // the corner vertex appears at u = 3 both as the first segment's far end and
    // the second's near end, so posts do not pinch there
    const corner = band.u.filter((value) => Math.abs(value - 3) < 1e-9);
    expect(corner).toHaveLength(6);
    expect(Math.max(...band.u)).toBeCloseTo(7, 6);
  });

  it("skips a duplicate node without losing the distance", () => {
    const band = fenceBand([
      [0, 0],
      [5, 0],
      [5, 0],
      [5, 2],
    ]);
    expect(Math.max(...band.u)).toBeCloseTo(7, 6);
  });

  it("colors a fence wooden and a guard rail metal", () => {
    const [wood] = fence(ORIGIN_METERS, SCALE, lineFeature("fence"));
    const [metal] = fence(ORIGIN_METERS, SCALE, lineFeature("guard_rail"));
    expect(colorOf(wood)).toBe(fenceColor("fence").getHexString());
    expect(colorOf(metal)).toBe(fenceColor("guard_rail").getHexString());
    expect(colorOf(wood)).not.toBe(colorOf(metal));
    expect(fenceColor("mystery").getHexString()).toBe(
      new THREE.Color(DEFAULT_FENCE_COLOR).getHexString(),
    );
  });

  it("takes the rings of a barrier drawn as an area", () => {
    const area = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [ORIGIN[0], ORIGIN[1]],
            [ORIGIN[0] + 2e-4, ORIGIN[1]],
            [ORIGIN[0] + 2e-4, ORIGIN[1] + 1e-4],
            [ORIGIN[0], ORIGIN[1] + 1e-4],
            [ORIGIN[0], ORIGIN[1]],
          ],
        ],
      },
      properties: { cmtype: "fence", barrier: "fence" },
    } as unknown as Geojson.Feature;
    const [geometry] = fence(ORIGIN_METERS, SCALE, area);
    // a closed ring of four segments -> eight triangles
    expect(geometry.getAttribute("position").count).toBe(4 * 6);
  });

  it("merges a tile's fences into one mesh with a matching attribute set", () => {
    const geometries = [
      ...fence(ORIGIN_METERS, SCALE, lineFeature()),
      ...fence(ORIGIN_METERS, SCALE, lineFeature("guard_rail")),
    ];
    const merged = BufferGeometryUtils.mergeGeometries(geometries);
    expect(merged).not.toBeNull();
    for (const name of ["color", "aU", "aZ"]) {
      expect(merged!.getAttribute(name).count).toBe(
        merged!.getAttribute("position").count,
      );
    }
  });

  it("keeps the rails to the middle and top of the band", () => {
    // a rail at the very ground would sit under the pavement and read as a curb
    expect(FENCE_RAILS).toHaveLength(3);
    for (const [center] of FENCE_RAILS) {
      expect(center).toBeGreaterThan(0.15);
      expect(center).toBeLessThan(1);
    }
    // posts are a small fraction of the pitch, or the fence becomes a wall
    expect(FENCE_POST_WIDTH).toBeLessThan(FENCE_PITCH * 0.1);
  });
});
