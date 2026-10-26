import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../projection";
import { playground } from "./playground";
import { hashSeed } from "./random";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(id = "way/1"): Geojson.Feature {
  return {
    type: "Feature",
    id,
    properties: { cmtype: "playground", size: 12 },
    geometry: { type: "Point", coordinates: [9.19, 45.46] },
  };
}

describe("playground", () => {
  it("builds a patch with swings, a slide and a spring rider", () => {
    const built = playground(ORIGIN_METERS, SCALE, feature());
    expect(built).toHaveLength(1);
    const geometry = built[0];
    const position = geometry.getAttribute("position");
    expect(position.count).toBeGreaterThan(0);
    for (const name of ["normal", "uv", "color"]) {
      expect(geometry.getAttribute(name)?.count).toBe(position.count);
    }
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    // the 12 m patch is the widest part
    expect(box.max.x - box.min.x).toBeGreaterThan(11);
    expect(box.max.z).toBeGreaterThan(2);
    expect(box.min.z).toBeGreaterThanOrEqual(-1e-6);
  });

  it("is stable for the same id", () => {
    const a = playground(ORIGIN_METERS, SCALE, feature("way/1"))[0];
    const b = playground(ORIGIN_METERS, SCALE, feature("way/1"))[0];
    expect(a.getAttribute("position").array).toEqual(
      b.getAttribute("position").array,
    );
  });

  it("stands the spring rider's post under its seat", () => {
    // The post is one cylinder built by a different call than the seat, so a
    // missing translate puts it at the patch center and the rider floats. The
    // bbox check above cannot see that: it only looks at the whole patch.
    const id = "way/1";
    const geometry = playground(ORIGIN_METERS, SCALE, feature(id))[0];
    // the builder rotates the whole patch by a seeded quarter turn; undo it so
    // the assert is in the patch's own frame
    const angle = (hashSeed(id) % 4) * (Math.PI / 2);
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    // size 12 is clamped to a 6 m radius patch, and the rider sits at y 0.3*patch
    const riderY = Math.min(12 / 2, 7) * 0.3;
    const position = geometry.getAttribute("position");
    let postVertices = 0;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      const localX = x * cos - y * sin;
      const localY = x * sin + y * cos;
      // below 0.3 is only the post: the seat and its back start at 0.5
      if (Math.hypot(localX, localY - riderY) < 0.25 && z < 0.3) {
        postVertices++;
      }
    }
    expect(postVertices).toBeGreaterThan(0);
  });

  it("rejects a non-point", () => {
    const line: Geojson.Feature = {
      ...feature(),
      geometry: {
        type: "LineString",
        coordinates: [
          [9.19, 45.46],
          [9.2, 45.46],
        ],
      },
    };
    expect(() => playground(ORIGIN_METERS, SCALE, line)).toThrow();
  });
});
