import type Geojson from "geojson";
import type * as THREE from "three";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../projection";
import { canopyVariation, tree } from "./tree";

// a spread of hashes, as generateHash produces them from tree ids
const HASHES = Array.from({ length: 200 }, (_, i) => (i * 2654435761) >>> 0);

describe("canopyVariation", () => {
  it("is deterministic for a given hash", () => {
    for (const h of HASHES.slice(0, 20)) {
      expect(canopyVariation(h)).toEqual(canopyVariation(h));
    }
  });

  it("keeps the crown variation subtle", () => {
    for (const h of HASHES) {
      const { radiusScale, squash } = canopyVariation(h);
      expect(radiusScale).toBeGreaterThanOrEqual(0.9);
      expect(radiusScale).toBeLessThanOrEqual(1.12);
      // never flat enough to open the trunk/canopy junction (the canopy bottom
      // still sits 0.1 * radius * squash below the trunk top)
      expect(squash).toBeGreaterThanOrEqual(0.82);
      expect(squash).toBeLessThanOrEqual(1.12);
    }
  });

  it("actually varies from tree to tree", () => {
    const radii = new Set(HASHES.map((h) => canopyVariation(h).radiusScale));
    const squashes = new Set(HASHES.map((h) => canopyVariation(h).squash));
    expect(radii.size).toBeGreaterThan(50);
    expect(squashes.size).toBeGreaterThan(50);
  });
});

describe("tree", () => {
  const ORIGIN: [number, number] = [9.19, 45.46];
  const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
  const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

  function point(props: Record<string, unknown> = {}): Geojson.Feature {
    return {
      type: "Feature",
      id: "node/1",
      properties: { cmtype: "tree", ...props },
      geometry: { type: "Point", coordinates: [9.19, 45.46] },
    };
  }

  it("merges a trunk and a canopy into one geometry", () => {
    const built = tree(ORIGIN_METERS, SCALE, point());
    expect(built).toHaveLength(1);
    const geometry = built[0];
    const position = geometry.getAttribute("position");
    expect(position.count).toBeGreaterThan(0);
    // the merge is the last thing that can fail: a missing attribute silently
    // leaves the tile with a bare trunk
    expect(geometry.getAttribute("color")?.count).toBe(position.count);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.z).toBeGreaterThan(1);
  });

  it("stands on the ground and grows upward", () => {
    const geometry = tree(ORIGIN_METERS, SCALE, point())[0];
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.min.z).toBeGreaterThanOrEqual(-1e-6);
    // the canopy is above the trunk, not inside it
    expect(box.max.z - box.min.z).toBeGreaterThan(1);
  });

  it("uses the size from the tile when there is one", () => {
    const small = tree(ORIGIN_METERS, SCALE, point({ size: 1 }))[0];
    const big = tree(ORIGIN_METERS, SCALE, point({ size: 4 }))[0];
    small.computeBoundingBox();
    big.computeBoundingBox();
    const width = (g: THREE.BufferGeometry) =>
      g.boundingBox!.max.x - g.boundingBox!.min.x;
    expect(width(big)).toBeGreaterThan(width(small));
  });

  it("builds a conifer and a broadleaf differently", () => {
    const conifer = tree(ORIGIN_METERS, SCALE, point({ type: "conifer" }))[0];
    const broadleaf = tree(
      ORIGIN_METERS,
      SCALE,
      point({ type: "broadleaf" }),
    )[0];
    const vertices = (g: THREE.BufferGeometry) =>
      g.getAttribute("position").count;
    // a cone is a different primitive from a squashed sphere
    expect(vertices(conifer)).not.toBe(vertices(broadleaf));
  });

  it("rejects anything that is not a point", () => {
    const line: Geojson.Feature = {
      ...point(),
      geometry: {
        type: "LineString",
        coordinates: [
          [9.19, 45.46],
          [9.2, 45.46],
        ],
      },
    };
    expect(() => tree(ORIGIN_METERS, SCALE, line)).toThrow();
  });
});
