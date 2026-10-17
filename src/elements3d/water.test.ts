import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857, waterInfo } from "../geojson_data";
import {
  DEFAULT_WATER_COLOR,
  UNDERWATER_OPACITY,
  WATERWAY_WIDTH,
  water,
  waterColor,
  waterFade,
} from "./water";

const ORIGIN: [number, number] = [9.18, 45.5];
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);

// ~20 m x 20 m square around the origin
function squareRing(): [number, number][] {
  const lon = ORIGIN[0];
  const lat = ORIGIN[1];
  return [
    [lon, lat],
    [lon + 2.6e-4, lat],
    [lon + 2.6e-4, lat + 1.8e-4],
    [lon, lat + 1.8e-4],
    [lon, lat],
  ];
}

function areaFeature(water = "lake"): Geojson.Feature {
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [squareRing()] },
    properties: { cmtype: "water", water },
  } as unknown as Geojson.Feature;
}

function lineFeature(water = "canal"): Geojson.Feature {
  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [ORIGIN[0] - 3e-4, ORIGIN[1]],
        [ORIGIN[0] + 3e-4, ORIGIN[1]],
      ],
    },
    properties: { cmtype: "water", water },
  } as unknown as Geojson.Feature;
}

const colorOf = (geometry: THREE.BufferGeometry): string =>
  new THREE.Color(
    geometry.getAttribute("color").getX(0),
    geometry.getAttribute("color").getY(0),
    geometry.getAttribute("color").getZ(0),
  ).getHexString();

describe("water", () => {
  it("builds a flat triangulated surface for an area", () => {
    const [geometry] = water(ORIGIN_METERS, SCALE, areaFeature());
    const position = geometry.getAttribute("position");
    expect(position.count).toBeGreaterThanOrEqual(3);
    expect(position.count % 3).toBe(0);
    for (let i = 0; i < position.count; i++) {
      expect(position.getZ(i)).toBe(0); // flat at ground level
    }
    expect(colorOf(geometry)).toBe(waterColor("lake").getHexString());
    // a surface feature is fully opaque
    const fade = geometry.getAttribute("aFade");
    expect(fade.count).toBe(position.count);
    for (let i = 0; i < fade.count; i++) expect(fade.getX(i)).toBe(1);
  });

  it("draws water below level 0 almost transparent", () => {
    const underwater = {
      ...areaFeature("lake"),
      properties: { cmtype: "water", water: "lake", level: -1 },
    } as unknown as Geojson.Feature;
    expect(waterFade(underwater)).toBe(UNDERWATER_OPACITY);
    expect(waterFade(areaFeature("lake"))).toBe(1); // no level -> surface
    const [geometry] = water(ORIGIN_METERS, SCALE, underwater);
    const fade = geometry.getAttribute("aFade");
    expect(fade.count).toBe(geometry.getAttribute("position").count);
    for (let i = 0; i < fade.count; i++) {
      expect(fade.getX(i)).toBeCloseTo(UNDERWATER_OPACITY, 6);
    }
  });

  it("buffers a line into a ribbon of the class width", () => {
    const [geometry] = water(ORIGIN_METERS, SCALE, lineFeature("canal"));
    const position = geometry.getAttribute("position");
    // one segment -> two triangles -> six vertices
    expect(position.count).toBe(6);
    // the first two vertices are the two sides of the first cross-section
    const width = Math.hypot(
      position.getX(1) - position.getX(0),
      position.getY(1) - position.getY(0),
    );
    expect(width).toBeCloseTo(WATERWAY_WIDTH.canal, 4);
    for (let i = 0; i < position.count; i++) {
      expect(position.getZ(i)).toBe(0);
    }
  });

  it("uses a different color and width per waterway class", () => {
    const [river] = water(ORIGIN_METERS, SCALE, lineFeature("river"));
    const position = river.getAttribute("position");
    const width = Math.hypot(
      position.getX(1) - position.getX(0),
      position.getY(1) - position.getY(0),
    );
    expect(width).toBeCloseTo(WATERWAY_WIDTH.river, 4);
    expect(width).toBeGreaterThan(WATERWAY_WIDTH.canal);
  });

  it("handles multi-geometries", () => {
    const multi: Geojson.Feature = {
      type: "Feature",
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [squareRing()],
          [squareRing().map(([x, y]) => [x, y + 4e-4])],
        ],
      },
      properties: { cmtype: "water", water: "reservoir" },
    } as unknown as Geojson.Feature;
    const parts = water(ORIGIN_METERS, SCALE, multi);
    expect(parts).toHaveLength(2);
  });

  it("merges areas and ribbons into one mesh", () => {
    // the tile pipeline merges every water geometry of a tile, so areas and
    // ribbons must expose the same attributes
    const geometries = [
      ...water(ORIGIN_METERS, SCALE, areaFeature()),
      ...water(ORIGIN_METERS, SCALE, lineFeature()),
    ];
    const merged = BufferGeometryUtils.mergeGeometries(geometries);
    expect(merged).not.toBeNull();
    expect(merged!.getAttribute("color").count).toBe(
      merged!.getAttribute("position").count,
    );
    expect(merged!.getAttribute("aFade").count).toBe(
      merged!.getAttribute("position").count,
    );
  });

  it("falls back to a default color for an unknown kind", () => {
    expect(waterColor("mystery").getHexString()).toBe(
      new THREE.Color(DEFAULT_WATER_COLOR).getHexString(),
    );
  });
});

describe("waterInfo", () => {
  it("collects area rings for picking", () => {
    const info = waterInfo(areaFeature("lake"));
    expect(info.rings).toHaveLength(1);
    expect(info.lines).toHaveLength(0);
    expect(info.kind).toBe("lake");
  });

  it("collects waterway centrelines for picking", () => {
    const info = waterInfo(lineFeature("canal"));
    expect(info.lines).toHaveLength(1);
    expect(info.rings).toHaveLength(0);
    expect(info.kind).toBe("canal");
  });

  it("keeps the OSM id and the name for the popup", () => {
    const feature = {
      ...areaFeature("river"),
      id: "way/42",
      properties: { cmtype: "water", water: "river", name: "Naviglio" },
    } as unknown as Geojson.Feature;
    const info = waterInfo(feature);
    expect(info.id).toBe("way/42");
    expect(info.name).toBe("Naviglio");
  });
});
