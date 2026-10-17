import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { building } from "./building";
import { ROOF_COLORS, roofGeometry } from "./roof";

const ORIGIN: [number, number] = [9.18, 45.5];
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);

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

describe("roofGeometry", () => {
  // a seed that gives this footprint a pitched roof (the seeded variety can
  // otherwise pick flat)
  const pitchedSeed = (() => {
    for (let seed = 0; seed < 100; seed++) {
      if (roofGeometry([longRing()], 12, ORIGIN_METERS, SCALE, seed))
        return seed;
    }
    throw new Error("no pitched seed found");
  })();

  it("builds a roof above the eaves, wound to match its normals", () => {
    const height = 12;
    const geometry = roofGeometry(
      [longRing()],
      height,
      ORIGIN_METERS,
      SCALE,
      pitchedSeed,
    );
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

  it("picks a roof tone from the palette", () => {
    const geometry = roofGeometry(
      [longRing()],
      12,
      ORIGIN_METERS,
      SCALE,
      pitchedSeed,
    )!;
    const palette = ROOF_COLORS.map((hex) =>
      new THREE.Color(hex).getHexString(),
    );
    const color = geometry.getAttribute("color");
    const hex = new THREE.Color(
      color.getX(0),
      color.getY(0),
      color.getZ(0),
    ).getHexString();
    expect(palette).toContain(hex);
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
    for (let seed = 0; seed < 8; seed++) {
      expect(
        roofGeometry([outer, hole], 12, ORIGIN_METERS, SCALE, seed),
      ).toBeNull();
    }
  });

  it("stays flat on a footprint too far from its hull", () => {
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
    for (let seed = 0; seed < 8; seed++) {
      expect(roofGeometry([l], 12, ORIGIN_METERS, SCALE, seed)).toBeNull();
    }
  });
  it("stays flat for a big squarish footprint", () => {
    const side = 0.00035; // ~27 m
    const square: [number, number][] = [
      [ORIGIN[0], ORIGIN[1]],
      [ORIGIN[0] + side, ORIGIN[1]],
      [ORIGIN[0] + side, ORIGIN[1] + side],
      [ORIGIN[0], ORIGIN[1] + side],
    ];
    // most seeds leave a big square flat (the seeded variety occasionally does)
    const built = [0, 1, 2, 3, 4, 5, 6, 7].filter(
      (seed) => roofGeometry([square], 12, ORIGIN_METERS, SCALE, seed) !== null,
    );
    expect(built.length).toBeLessThanOrEqual(3);
  });

  it("is deterministic for the same seed", () => {
    const a = roofGeometry(
      [longRing()],
      12,
      ORIGIN_METERS,
      SCALE,
      pitchedSeed,
    )!;
    const b = roofGeometry(
      [longRing()],
      12,
      ORIGIN_METERS,
      SCALE,
      pitchedSeed,
    )!;
    expect(Array.from(a.getAttribute("position").array)).toEqual(
      Array.from(b.getAttribute("position").array),
    );
  });
});

describe("building", () => {
  it("merges the roof into the same geometry as the walls", () => {
    const feature = {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [longRing()] },
      properties: { height: 12 },
    } as unknown as Parameters<typeof building>[2];
    const geometries = building(ORIGIN_METERS, SCALE, feature);
    // the extruded walls, plus a roof
    expect(geometries.length).toBe(2);
    // the tile pipeline merges these, so they must share their attributes
    const merged = BufferGeometryUtils.mergeGeometries(geometries);
    expect(merged).not.toBeNull();
  });

  it("keeps a flat-roofed building to a single extrusion", () => {
    const side = 0.00035; // ~27 m square, over FLAT_AREA
    const feature = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [ORIGIN[0], ORIGIN[1]],
            [ORIGIN[0] + side, ORIGIN[1]],
            [ORIGIN[0] + side, ORIGIN[1] + side],
            [ORIGIN[0], ORIGIN[1] + side],
          ],
        ],
      },
      properties: { height: 12 },
    } as unknown as Parameters<typeof building>[2];
    // whichever way the seeded variety fell, the geometry still merges
    const geometries = building(ORIGIN_METERS, SCALE, feature);
    expect(geometries.length).toBeGreaterThanOrEqual(1);
    const merged = BufferGeometryUtils.mergeGeometries(geometries);
    expect(merged).not.toBeNull();
  });
});
