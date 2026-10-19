import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import {
  DEFAULT_GREEN_COLOR,
  DEFAULT_GREEN_STYLE,
  GREEN_Z,
  green,
  greenColor,
  greenStyle,
} from "./green";

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

function areaFeature(kind: string): Geojson.Feature {
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [squareRing()] },
    properties: { cmtype: "green", green: kind },
  } as unknown as Geojson.Feature;
}

const colorOf = (geometry: THREE.BufferGeometry): string =>
  new THREE.Color(
    geometry.getAttribute("color").getX(0),
    geometry.getAttribute("color").getY(0),
    geometry.getAttribute("color").getZ(0),
  ).getHexString();

describe("green", () => {
  it("builds a flat triangulated surface just under the water", () => {
    const [geometry] = green(ORIGIN_METERS, SCALE, areaFeature("grass"));
    const position = geometry.getAttribute("position");
    expect(position.count).toBeGreaterThanOrEqual(3);
    expect(position.count % 3).toBe(0);
    for (let i = 0; i < position.count; i++) {
      expect(position.getZ(i)).toBeCloseTo(GREEN_Z, 6);
    }
    expect(colorOf(geometry)).toBe(greenColor("grass").getHexString());
  });

  it("bakes the shader style as a per-vertex attribute", () => {
    const [lawn] = green(ORIGIN_METERS, SCALE, areaFeature("grass"));
    const [park] = green(ORIGIN_METERS, SCALE, areaFeature("dense"));
    const lawnStyle = lawn.getAttribute("aStyle");
    const parkStyle = park.getAttribute("aStyle");
    expect(lawnStyle.count).toBe(lawn.getAttribute("position").count);
    for (let i = 0; i < lawnStyle.count; i++) expect(lawnStyle.getX(i)).toBe(0);
    for (let i = 0; i < parkStyle.count; i++) expect(parkStyle.getX(i)).toBe(1);
  });

  it("merges areas of both styles into one mesh", () => {
    // the tile pipeline merges every green geometry, so the attribute sets must
    // agree across features
    const geometries = [
      ...green(ORIGIN_METERS, SCALE, areaFeature("grass")),
      ...green(ORIGIN_METERS, SCALE, areaFeature("dense")),
    ];
    const merged = BufferGeometryUtils.mergeGeometries(geometries);
    expect(merged).not.toBeNull();
    const count = merged!.getAttribute("position").count;
    expect(merged!.getAttribute("color").count).toBe(count);
    expect(merged!.getAttribute("aStyle").count).toBe(count);
    expect(merged!.getAttribute("normal")).toBeUndefined();
    expect(merged!.getAttribute("uv")).toBeUndefined();
  });

  it("triangulates a hole and a multi-polygon", () => {
    const inner: [number, number][] = [
      [ORIGIN[0] + 6e-5, ORIGIN[1] + 4e-5],
      [ORIGIN[0] + 2e-4, ORIGIN[1] + 4e-5],
      [ORIGIN[0] + 2e-4, ORIGIN[1] + 1.4e-4],
      [ORIGIN[0] + 6e-5, ORIGIN[1] + 1.4e-4],
      [ORIGIN[0] + 6e-5, ORIGIN[1] + 4e-5],
    ];
    const holed: Geojson.Feature = {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [squareRing(), inner] },
      properties: { cmtype: "green", green: "grass" },
    } as unknown as Geojson.Feature;
    const [withHole] = green(ORIGIN_METERS, SCALE, holed);
    expect(withHole.getAttribute("position").count).toBeGreaterThanOrEqual(3);

    const multi: Geojson.Feature = {
      type: "Feature",
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [squareRing()],
          [squareRing().map(([x, y]) => [x, y + 4e-4])],
        ],
      },
      properties: { cmtype: "green", green: "dense" },
    } as unknown as Geojson.Feature;
    expect(green(ORIGIN_METERS, SCALE, multi)).toHaveLength(2);
  });

  it("falls back to the lawn style and default color for an unknown kind", () => {
    expect(greenStyle("mystery")).toBe(DEFAULT_GREEN_STYLE);
    expect(greenStyle("dense")).toBe(1);
    expect(greenColor("mystery").getHexString()).toBe(
      new THREE.Color(DEFAULT_GREEN_COLOR).getHexString(),
    );
  });
});
