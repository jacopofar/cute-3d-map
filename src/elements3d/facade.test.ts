import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  epsg4326toEpsg3857,
  toModelCoords,
  type BuildingInfo,
} from "../geojson_data";
import { tileFacadeDetail, FACADE_COLORS } from "./facade";
import { GROUND_CLEARANCE } from "./facade_layout";

const ORIGIN: [number, number] = [9.18, 45.5];
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);

// a roughly 12 m square footprint, counter-clockwise like an OSM exterior ring
function square(halfLon = 7.7e-5, halfLat = 5.4e-5): [number, number][] {
  const [lon, lat] = ORIGIN;
  return [
    [lon - halfLon, lat - halfLat],
    [lon + halfLon, lat - halfLat],
    [lon + halfLon, lat + halfLat],
    [lon - halfLon, lat + halfLat],
  ];
}

const building = (over: Partial<BuildingInfo> = {}): BuildingInfo => ({
  rings: [square()],
  height: 12,
  imputed: [],
  ...over,
});

const DOOR = new THREE.Color(0x6b4a2f);

describe("tileFacadeDetail", () => {
  it("emits quad geometry for a building", () => {
    const detail = tileFacadeDetail(ORIGIN_METERS, SCALE, [building()]);
    expect(detail.windows).not.toBeNull();
    const position = detail.windows!.getAttribute("position");
    expect(position.count).toBeGreaterThan(0);
    expect(position.count % 6).toBe(0); // whole quads (two triangles)
    expect(detail.windows!.getAttribute("normal").count).toBe(position.count);
    expect(detail.windows!.getAttribute("color").count).toBe(position.count);
  });

  it("returns empty groups when there is nothing to emit", () => {
    // a building too low for any window and any door
    const detail = tileFacadeDetail(ORIGIN_METERS, SCALE, [
      building({ height: 1 }),
    ]);
    expect(detail.windows).toBeNull();
    expect(detail.balconies).toBeNull();
  });

  it("keeps the windows and the balconies in separate geometries", () => {
    const detail = tileFacadeDetail(ORIGIN_METERS, SCALE, [
      building({ rings: [square(2.6e-4, 1.8e-4)], height: 30 }),
    ]);
    expect(detail.windows).not.toBeNull();
    expect(detail.balconies).not.toBeNull();
    // the balconies carry no glass tone, the windows no horizontal face
    expect(horizontalFaces(detail.windows)).toBe(0);
    expect(horizontalFaces(detail.balconies)).toBeGreaterThan(0);
  });

  it("faces every window and door outward, away from the footprint centre", () => {
    const info = building();
    // the window group is the flat wall quads: the door and the windows
    const geometry = tileFacadeDetail(ORIGIN_METERS, SCALE, [info]).windows!;
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    // centre of the footprint in model space
    const corners = info.rings[0].map((c) =>
      toModelCoords([c[0], c[1]], ORIGIN_METERS, SCALE),
    );
    const cx = corners.reduce((s, c) => s + c[0], 0) / corners.length;
    const cy = corners.reduce((s, c) => s + c[1], 0) / corners.length;
    let checked = 0;
    for (let i = 0; i < position.count; i++) {
      checked++;
      const outward =
        (position.getX(i) - cx) * normal.getX(i) +
        (position.getY(i) - cy) * normal.getY(i);
      expect(outward).toBeGreaterThan(0);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("puts windows above the ground and one door at the ground", () => {
    const geometry = tileFacadeDetail(ORIGIN_METERS, SCALE, [
      building(),
    ]).windows!;
    const position = geometry.getAttribute("position");
    const color = geometry.getAttribute("color");
    let doorVertices = 0;
    for (let i = 0; i < position.count; i++) {
      const isDoor =
        Math.abs(color.getX(i) - DOOR.r) < 1e-6 &&
        Math.abs(color.getY(i) - DOOR.g) < 1e-6 &&
        Math.abs(color.getZ(i) - DOOR.b) < 1e-6;
      if (isDoor) {
        doorVertices++;
        expect(position.getZ(i)).toBeLessThanOrEqual(2.2);
      } else {
        expect(position.getZ(i)).toBeGreaterThanOrEqual(
          GROUND_CLEARANCE - 1e-6,
        );
      }
    }
    expect(doorVertices).toBe(6); // exactly one door
  });

  it("is deterministic for the same building", () => {
    const a = tileFacadeDetail(ORIGIN_METERS, SCALE, [building()]).windows!;
    const b = tileFacadeDetail(ORIGIN_METERS, SCALE, [building()]).windows!;
    expect(Array.from(a.getAttribute("position").array)).toEqual(
      Array.from(b.getAttribute("position").array),
    );
  });

  it("winds every triangle to match its normal, clockwise ring included", () => {
    // the geometry must face the same way whatever the ring winding: OSM
    // exterior rings come in both, and three.js culls back faces
    for (const reversed of [false, true]) {
      const ring = square();
      const info = building({ rings: [reversed ? [...ring].reverse() : ring] });
      const detail = tileFacadeDetail(ORIGIN_METERS, SCALE, [info]);
      // both groups must be wound to face outward
      for (const geometry of [
        detail.windows!,
        detail.balconies ?? detail.windows!,
      ]) {
        const position = geometry.getAttribute("position");
        const normal = geometry.getAttribute("normal");
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
      }
    }
  });

  it("adds no balconies on a single-floor building", () => {
    const detail = tileFacadeDetail(ORIGIN_METERS, SCALE, [
      building({ height: 4 }),
    ]);
    expect(horizontalFaces(detail.balconies)).toBe(0);
  });

  it("adds balconies to a tall building", () => {
    // ~40 m square, 30 m tall: plenty of eligible floors, so some appear
    const detail = tileFacadeDetail(ORIGIN_METERS, SCALE, [
      building({ rings: [square(2.6e-4, 1.8e-4)], height: 30 }),
    ]);
    expect(horizontalFaces(detail.balconies)).toBeGreaterThan(0);
  });

  it("gives every window on a building one color, picked per building", () => {
    const one = windowTone(
      tileFacadeDetail(ORIGIN_METERS, SCALE, [building()]).windows,
    );
    expect(one).not.toBeNull();

    const tones = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const ring = square().map(([lon, lat]): [number, number] => [
        lon + i * 0.001,
        lat,
      ]);
      const detail = tileFacadeDetail(ORIGIN_METERS, SCALE, [
        building({ rings: [ring] }),
      ]);
      const tone = windowTone(detail.windows);
      if (tone) tones.add(tone);
    }
    expect(tones.size).toBeGreaterThan(1);
    expect(tones.size).toBeLessThanOrEqual(FACADE_COLORS.window.length);
  });
});

// the color of the first window vertex, or null when there is none
function windowTone(geometry: THREE.BufferGeometry | null): string | null {
  if (!geometry) return null;
  const palette = FACADE_COLORS.window.map((hex) =>
    new THREE.Color(hex).getHexString(),
  );
  const color = geometry.getAttribute("color");
  for (let i = 0; i < color.count; i++) {
    const hex = new THREE.Color(
      color.getX(i),
      color.getY(i),
      color.getZ(i),
    ).getHexString();
    if (palette.includes(hex)) return hex;
  }
  return null;
}

// balcony slabs are the only horizontal faces, so a |normal.z| > 0.5 vertex is
// proof a balcony was emitted
function horizontalFaces(geometry: THREE.BufferGeometry | null): number {
  if (!geometry) return 0;
  const normal = geometry.getAttribute("normal");
  let count = 0;
  for (let i = 0; i < normal.count; i++) {
    if (Math.abs(normal.getZ(i)) > 0.5) count++;
  }
  return count;
}
