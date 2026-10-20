import { describe, expect, it } from "vitest";

import { canopyVariation } from "./tree";

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
