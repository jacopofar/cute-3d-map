import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../projection";
import { building } from "./building";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(
  properties: Record<string, unknown>,
  coordinates = [
    [
      [9.189, 45.459],
      [9.191, 45.459],
      [9.191, 45.461],
      [9.189, 45.461],
      [9.189, 45.459],
    ],
  ],
): Geojson.Feature {
  return {
    type: "Feature",
    id: "way/766529419",
    properties,
    geometry: { type: "Polygon", coordinates },
  };
}

function topColor(f: Geojson.Feature): [number, number, number] {
  const built = building(ORIGIN_METERS, SCALE, f);
  const walls = built[0].walls;
  const position = walls.getAttribute("position");
  const normal = walls.getAttribute("normal");
  const color = walls.getAttribute("color");
  let best = -1;
  let bestZ = -Infinity;
  for (let i = 0; i < position.count; i++) {
    if (normal.getZ(i) > 0.5 && position.getZ(i) > bestZ) {
      bestZ = position.getZ(i);
      best = i;
    }
  }
  return [color.getX(best), color.getY(best), color.getZ(best)];
}

describe("building", () => {
  it("lifts a building part from min_height to height", () => {
    const built = building(
      ORIGIN_METERS,
      SCALE,
      feature({ building: "university", height: 15, base: 10 }),
    );
    expect(built).toHaveLength(1);
    built[0].walls.computeBoundingBox();
    expect(built[0].walls.boundingBox!.min.z).toBeCloseTo(10, 5);
    expect(built[0].walls.boundingBox!.max.z).toBeCloseTo(15, 5);
    built[0].roof?.computeBoundingBox();
    if (built[0].roof) {
      expect(built[0].roof.boundingBox!.min.z).toBeGreaterThanOrEqual(15);
    }
  });

  it("paints the flat top of a concave building with the roof color", () => {
    // an L footprint: roofGeometry leaves it flat, but the cap keeps roof_color
    const concave = [
      [
        [9.189, 45.459],
        [9.191, 45.459],
        [9.191, 45.4595],
        [9.1895, 45.4595],
        [9.1895, 45.461],
        [9.189, 45.461],
        [9.189, 45.459],
      ],
    ];
    const f = feature(
      {
        building: "yes",
        height: 10,
        roof_shape: "gabled",
        roof_color: "#ff0000",
      },
      concave,
    );
    const built = building(ORIGIN_METERS, SCALE, f);
    expect(built[0].roof).toBeNull();
    const color = topColor(f);
    expect(color[0]).toBeGreaterThan(0.9);
    expect(color[1]).toBeLessThan(0.1);
    expect(color[2]).toBeLessThan(0.1);
  });

  it("keeps the roof flat under mapped solar panels", () => {
    const built = building(
      ORIGIN_METERS,
      SCALE,
      feature({
        building: "yes",
        height: 10,
        roof_shape: "pyramidal",
        solar: true,
      }),
    );
    expect(built[0].roof).toBeNull();
  });

  it("keeps an ordinary building on the ground", () => {
    const built = building(
      ORIGIN_METERS,
      SCALE,
      feature({ building: "yes", height: 12 }),
    );
    built[0].walls.computeBoundingBox();
    expect(built[0].walls.boundingBox!.min.z).toBeCloseTo(0, 5);
  });
});
