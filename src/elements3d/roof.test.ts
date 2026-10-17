import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { building } from "./building";
import { DEFAULT_ROOF_COLOR, roofGeometry } from "./roof";

const ORIGIN: [number, number] = [9.18, 45.5];
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const ROOF_COLOR = "#b0553c";

// ~30 m x 12 m footprint (long, narrow), counter-clockwise
function longRing(): [number, number][] {
  const lon = ORIGIN[0];
  const lat = ORIGIN[1];
  return [
    [lon, lat],
    [lon + 3.85e-4, lat],
    [lon + 3.85e-4, lat + 1.09e-4],
    [lon, lat + 1.09e-4],
  ];
}

const roof = (
  shape: string | undefined,
  height = 12,
  rings = [longRing()],
  color: string | undefined = ROOF_COLOR,
) => roofGeometry(rings, height, ORIGIN_METERS, SCALE, shape, color);

describe("roofGeometry", () => {
  it("builds a roof above the eaves, wound to match its normals", () => {
    const height = 12;
    const geometry = roof("gabled", height);
    expect(geometry).not.toBeNull();
    const position = geometry!.getAttribute("position");
    const normal = geometry!.getAttribute("normal");
    const color = geometry!.getAttribute("color");
    expect(position.count).toBeGreaterThan(0);
    expect(position.count % 3).toBe(0);
    expect(normal.count).toBe(position.count);
    expect(color.count).toBe(position.count);

    let top = -Infinity;
    for (let i = 0; i < position.count; i++) {
      // every roof vertex is at or above the eave height
      expect(position.getZ(i)).toBeGreaterThanOrEqual(height - 1e-6);
      top = Math.max(top, position.getZ(i));
    }
    // ... and reaches the ridge
    expect(top).toBeGreaterThan(height + 0.5);

    for (let t = 0; t < position.count; t += 3) {
      const tri = [0, 1, 2].map((o): [number, number, number] => [
        position.getX(t + o),
        position.getY(t + o),
        position.getZ(t + o),
      ]);
      const u = tri[1].map((c, i) => c - tri[0][i]);
      const v = tri[2].map((c, i) => c - tri[0][i]);
      const cross = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
      ];
      const facing = [normal.getX(t), normal.getY(t), normal.getZ(t)];
      const dot =
        cross[0] * facing[0] + cross[1] * facing[1] + cross[2] * facing[2];
      expect(dot).toBeGreaterThan(0);
    }
  });

  it("uses the roof color it is given", () => {
    const geometry = roof("gabled", 12, [longRing()], "#b0553c")!;
    const color = geometry.getAttribute("color");
    const hex = new THREE.Color(
      color.getX(0),
      color.getY(0),
      color.getZ(0),
    ).getHexString();
    expect(hex).toBe(new THREE.Color("#b0553c").getHexString());
  });

  it("falls back when the roof color is not usable", () => {
    const geometry = roof("gabled", 12, [longRing()], "not a color")!;
    const color = geometry.getAttribute("color");
    const hex = new THREE.Color(
      color.getX(0),
      color.getY(0),
      color.getZ(0),
    ).getHexString();
    expect(hex).toBe(new THREE.Color(DEFAULT_ROOF_COLOR).getHexString());
  });

  it("stays flat when the shape is flat", () => {
    expect(roof("flat")).toBeNull();
  });

  it("stays flat for a shape it cannot render", () => {
    for (const shape of ["skillion", "mansard", "saltbox", "round"]) {
      expect(roof(shape)).toBeNull();
    }
  });

  it("stays flat when the footprint has an inner ring", () => {
    // a courtyard: the outer square plus a hole
    const outer = longRing();
    const hole: [number, number][] = [
      [outer[0][0] + 1e-4, outer[0][1] + 3e-5],
      [outer[0][0] + 2e-4, outer[0][1] + 3e-5],
      [outer[0][0] + 2e-4, outer[0][1] + 8e-5],
      [outer[0][0] + 1e-4, outer[0][1] + 8e-5],
    ];
    expect(roof("gabled", 12, [outer, hole])).toBeNull();
  });

  it("stays flat on a footprint too complex to roof", () => {
    // an L: a 10 x 10 square missing a 6 x 6 corner, in degrees
    const d = 1.3e-4; // ~10 m
    const x0 = ORIGIN[0];
    const y0 = ORIGIN[1];
    const l: [number, number][] = [
      [x0, y0],
      [x0 + d, y0],
      [x0 + d, y0 + 0.4 * d],
      [x0 + 0.4 * d, y0 + 0.4 * d],
      [x0 + 0.4 * d, y0 + d],
      [x0, y0 + d],
    ];
    expect(roof("gabled", 12, [l])).toBeNull();
  });
});

describe("building", () => {
  const feature = (properties: Record<string, unknown>) =>
    ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [longRing()] },
      properties,
    }) as unknown as Parameters<typeof building>[2];

  it("returns the walls and the roof as separate geometries", () => {
    const parts = building(
      ORIGIN_METERS,
      SCALE,
      feature({ height: 12, roof_shape: "gabled", roof_color: "#b0553c" }),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].roof).not.toBeNull();
    // the tile pipeline merges each kind, so they must share their attributes
    const merged = BufferGeometryUtils.mergeGeometries([
      parts[0].walls,
      parts[0].roof!,
    ]);
    expect(merged).not.toBeNull();
  });

  it("gives a flat-roofed building no roof geometry", () => {
    const parts = building(
      ORIGIN_METERS,
      SCALE,
      feature({ height: 12, roof_shape: "flat" }),
    );
    expect(parts[0].roof).toBeNull();
    const merged = BufferGeometryUtils.mergeGeometries([parts[0].walls]);
    expect(merged).not.toBeNull();
  });

  it("uses an imputed color, or ignores it when asked to", () => {
    const tagged = feature({
      height: 12,
      color: "coral",
      roof_shape: "gabled",
      roof_color: "gold",
    });
    const imputed = feature({
      height: 12,
      color: "coral",
      roof_shape: "gabled",
      roof_color: "gold",
      imputed: ["color", "roof_color"],
    });
    const toneOf = (geometry: THREE.BufferGeometry | null) =>
      geometry && geometry.getAttribute("color").count > 0
        ? new THREE.Color(
            geometry.getAttribute("color").getX(0),
            geometry.getAttribute("color").getY(0),
            geometry.getAttribute("color").getZ(0),
          ).getHexString()
        : null;

    // a real color is used either way
    expect(toneOf(building(ORIGIN_METERS, SCALE, tagged, false)[0].walls)).toBe(
      new THREE.Color("coral").getHexString(),
    );
    // an imputed one is dropped when the option is off
    const parts = building(ORIGIN_METERS, SCALE, imputed, false);
    expect(toneOf(parts[0].walls)).toBe(
      new THREE.Color("#aaaaaa").getHexString(),
    );
    expect(toneOf(parts[0].roof)).toBe(
      new THREE.Color(DEFAULT_ROOF_COLOR).getHexString(),
    );
    // ... and kept when it is on
    const on = building(ORIGIN_METERS, SCALE, imputed, true);
    expect(toneOf(on[0].walls)).toBe(new THREE.Color("coral").getHexString());
    expect(toneOf(on[0].roof)).toBe(new THREE.Color("gold").getHexString());
  });
});
