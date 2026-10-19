import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857, type BuildingInfo } from "../geojson_data";
import { building } from "./building";
import {
  CHURCH_CROSS_COLOR,
  CHURCH_PITCH,
  CHURCH_ROOF_COLORS,
  CHURCH_WALL_COLORS,
  CROSS_ARM,
  CROSS_HEIGHT,
  PARAPET_HEIGHT,
  church,
  churchRoofColor,
  isChurch,
} from "./church";
import { roofGeometry } from "./roof";

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

// an L, which no ridge fan can cover: it stays flat
function concaveRing(): [number, number][] {
  const d = 1.3e-4; // ~10 m
  const x0 = ORIGIN[0];
  const y0 = ORIGIN[1];
  return [
    [x0, y0],
    [x0 + d, y0],
    [x0 + d, y0 + 0.4 * d],
    [x0 + 0.4 * d, y0 + 0.4 * d],
    [x0 + 0.4 * d, y0 + d],
    [x0, y0 + d],
  ];
}

const info = (rings: [number, number][][], height: number): BuildingInfo => ({
  rings,
  height,
  imputed: [],
});

// the z a geometry reaches, and how far it spans
function bounds(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute("position");
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < position.count; i++) {
    min.x = Math.min(min.x, position.getX(i));
    min.y = Math.min(min.y, position.getY(i));
    max.x = Math.max(max.x, position.getX(i));
    max.y = Math.max(max.y, position.getY(i));
    min.z = Math.min(min.z, position.getZ(i));
    max.z = Math.max(max.z, position.getZ(i));
  }
  return { min, max };
}

describe("isChurch", () => {
  it("knows the OSM building values that are a church", () => {
    for (const value of [
      "church",
      "cathedral",
      "chapel",
      "basilica",
      "abbey",
      "monastery",
    ]) {
      expect(isChurch({ building: value })).toBe(true);
      // the tag is free text, so case and spaces do not matter
      expect(isChurch({ building: ` ${value.toUpperCase()} ` })).toBe(true);
    }
  });

  it("takes a Christian place of worship, whatever its building value", () => {
    // tilegen reports religion only for a place of worship
    expect(isChurch({ building: "yes", religion: "christian" })).toBe(true);
    // ... and a denomination is still Christian
    expect(isChurch({ religion: "christian:catholic" })).toBe(true);
    expect(isChurch({ building: "yes", religion: "Christian:Orthodox" })).toBe(
      true,
    );
  });

  it("leaves everything else alone", () => {
    expect(isChurch(undefined)).toBe(false);
    expect(isChurch({})).toBe(false);
    expect(isChurch({ building: "yes" })).toBe(false);
    expect(isChurch({ building: "apartments" })).toBe(false);
    expect(isChurch({ building: "chapel_of_ease" })).toBe(false);
    // a mosque, a synagogue, a temple: a place of worship, but not this look
    expect(isChurch({ building: "yes", religion: "muslim" })).toBe(false);
    expect(isChurch({ religion: "jewish" })).toBe(false);
    expect(isChurch({ religion: "buddhist" })).toBe(false);
  });
});

describe("church", () => {
  it("stands the cross on the ridge of the roof below it", () => {
    const height = 12;
    const ring = longRing();
    const cross = church(ORIGIN_METERS, SCALE, info([ring], height));
    expect(cross).toHaveLength(1);

    // the roof this footprint actually gets, pitched like a church
    const roof = roofGeometry(
      [ring],
      height,
      ORIGIN_METERS,
      SCALE,
      "gabled",
      "#55606b",
      CHURCH_PITCH,
    );
    expect(roof).not.toBeNull();
    const crossBounds = bounds(cross[0]);
    const roofBounds = bounds(roof!);
    // the base of the upright sits on the ridge, not above or inside it
    expect(crossBounds.min.z).toBeCloseTo(roofBounds.max.z, 6);
    // and the cross is a cross: its height and its arms keep the proportions,
    // scaled a little above the base size for a building this big (float32)
    const tall = crossBounds.max.z - crossBounds.min.z;
    expect(tall).toBeGreaterThanOrEqual(CROSS_HEIGHT - 1e-3);
    expect(tall).toBeLessThanOrEqual(2 * CROSS_HEIGHT + 1e-3);
    const wide = Math.max(
      crossBounds.max.x - crossBounds.min.x,
      crossBounds.max.y - crossBounds.min.y,
    );
    expect(wide / tall).toBeCloseTo(CROSS_ARM / CROSS_HEIGHT, 3);
  });

  it("sits just above the cap when the footprint cannot take a pitched roof", () => {
    const height = 12;
    const cross = church(ORIGIN_METERS, SCALE, info([concaveRing()], height));
    expect(cross).toHaveLength(1);
    const { min } = bounds(cross[0]);
    expect(min.z).toBeCloseTo(height + PARAPET_HEIGHT, 6);
  });

  it("carries the attributes a tile can merge, and a gold tone", () => {
    const first = church(ORIGIN_METERS, SCALE, info([longRing()], 12))[0];
    const second = church(ORIGIN_METERS, SCALE, info([longRing()], 20))[0];
    for (const geometry of [first, second]) {
      expect(geometry.index).toBeNull();
      expect(geometry.getAttribute("position").count % 3).toBe(0);
      expect(geometry.getAttribute("normal").count).toBe(
        geometry.getAttribute("position").count,
      );
      expect(geometry.getAttribute("uv").count).toBe(
        geometry.getAttribute("position").count,
      );
      expect(geometry.getAttribute("color").count).toBe(
        geometry.getAttribute("position").count,
      );
    }
    expect(BufferGeometryUtils.mergeGeometries([first, second])).not.toBeNull();
    const color = first.getAttribute("color");
    expect(
      new THREE.Color(
        color.getX(0),
        color.getY(0),
        color.getZ(0),
      ).getHexString(),
    ).toBe(new THREE.Color(CHURCH_CROSS_COLOR).getHexString());
  });

  it("has nothing to stand on without a ring", () => {
    expect(church(ORIGIN_METERS, SCALE, info([], 12))).toEqual([]);
  });
});

describe("building, for a church", () => {
  const feature = (properties: Record<string, unknown>) =>
    ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [longRing()] },
      properties,
    }) as unknown as Parameters<typeof building>[2];

  const wallTone = (parts: ReturnType<typeof building>) =>
    new THREE.Color(
      parts[0].walls.getAttribute("color").getX(0),
      parts[0].walls.getAttribute("color").getY(0),
      parts[0].walls.getAttribute("color").getZ(0),
    ).getHexString();

  const roofTone = (parts: ReturnType<typeof building>) => {
    const color = parts[0].roof!.getAttribute("color");
    return new THREE.Color(
      color.getX(0),
      color.getY(0),
      color.getZ(0),
    ).getHexString();
  };

  const hex = (value: string) => new THREE.Color(value).getHexString();

  it("gets a stone-tone wall and a slate roof over an imputed color", () => {
    const parts = building(
      ORIGIN_METERS,
      SCALE,
      feature({
        building: "church",
        height: 12,
        roof_shape: "gabled",
        roof_color: "#bf7182",
        color: "white",
        imputed: ["color", "roof_color"],
      }),
    );
    expect(CHURCH_WALL_COLORS.map(hex)).toContain(wallTone(parts));
    expect(CHURCH_ROOF_COLORS.map(hex)).toContain(roofTone(parts));
  });

  it("keeps the tone even with the imputed colors switched off", () => {
    // the palette is this building's look, not a sampled value
    const parts = building(
      ORIGIN_METERS,
      SCALE,
      feature({
        building: "church",
        height: 12,
        color: "white",
        roof_color: "#bf7182",
        imputed: ["color", "roof_color"],
      }),
      false,
    );
    expect(CHURCH_WALL_COLORS.map(hex)).toContain(wallTone(parts));
    expect(CHURCH_ROOF_COLORS.map(hex)).toContain(roofTone(parts));
  });

  it("lets a real OSM color win, and never imputes one itself", () => {
    const parts = building(
      ORIGIN_METERS,
      SCALE,
      feature({
        building: "church",
        height: 12,
        color: "#ff0000",
        roof_color: "#00ff00",
      }),
    );
    expect(wallTone(parts)).toBe(hex("#ff0000"));
    expect(roofTone(parts)).toBe(hex("#00ff00"));
  });

  it("forces a gabled, steeper roof", () => {
    const ring = longRing();
    const flat = building(
      ORIGIN_METERS,
      SCALE,
      feature({ building: "church", height: 12, roof_shape: "flat" }),
    );
    expect(flat[0].roof).not.toBeNull();
    const plain = roofGeometry(
      [ring],
      12,
      ORIGIN_METERS,
      SCALE,
      "gabled",
      undefined,
    )!;
    const steeper = bounds(flat[0].roof!).max.z;
    expect(steeper).toBeGreaterThan(bounds(plain).max.z);
  });

  it("leaves a plain building's colors to tilegen", () => {
    const parts = building(
      ORIGIN_METERS,
      SCALE,
      feature({
        building: "apartments",
        height: 12,
        color: "#bf7182",
        roof_color: "#bf7182",
        roof_shape: "gabled",
        imputed: ["roof_color"],
      }),
    );
    expect(wallTone(parts)).toBe(hex("#bf7182"));
    // only the church forces the slate tone
    expect(roofTone(parts)).toBe(hex("#bf7182"));
  });
});

describe("churchRoofColor", () => {
  it("is stable for one building and drawn from the slate palette", () => {
    const anchor = "9.18,45.5";
    expect(churchRoofColor(anchor)).toBe(churchRoofColor(anchor));
    expect(CHURCH_ROOF_COLORS).toContain(churchRoofColor(anchor));
  });
});
