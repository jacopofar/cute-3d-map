import type Geojson from "geojson";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857 } from "../geojson_data";
import { transitStop } from "./transit";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function feature(
  kind: string,
  shelter = false,
  id = "node/1",
): Geojson.Feature {
  return {
    type: "Feature",
    id,
    properties: { cmtype: "transit_stop", stop: kind, shelter },
    geometry: { type: "Point", coordinates: [9.19, 45.46] },
  };
}

describe("transitStop", () => {
  it("gives a metro entrance a body and a crossed M sign", () => {
    const { body, sign } = transitStop(ORIGIN_METERS, SCALE, feature("metro"));
    expect(body).toHaveLength(1);
    expect(sign).toHaveLength(1);
    for (const geometry of [...body, ...sign]) {
      const position = geometry.getAttribute("position");
      expect(position.count).toBeGreaterThan(0);
      expect(geometry.getAttribute("normal")?.count).toBe(position.count);
      expect(geometry.getAttribute("uv")?.count).toBe(position.count);
    }
    // the sign is two double-sided planes, so two sets of 4 corners
    expect(sign[0].getAttribute("position").count).toBe(8);
  });

  it("adds the shelter and its bench when the stop is covered", () => {
    const open = transitStop(ORIGIN_METERS, SCALE, feature("bus"));
    const covered = transitStop(ORIGIN_METERS, SCALE, feature("bus", true));
    expect(open.sign).toHaveLength(0);
    expect(open.body[0].getAttribute("position").count).toBeGreaterThan(0);
    expect(covered.body[0].getAttribute("position").count).toBeGreaterThan(
      open.body[0].getAttribute("position").count,
    );
  });

  it("treats a tram stop like a bus stop and rejects an unknown kind", () => {
    const tram = transitStop(ORIGIN_METERS, SCALE, feature("tram"));
    expect(tram.body).toHaveLength(1);
    expect(tram.sign).toHaveLength(0);
    expect(() => transitStop(ORIGIN_METERS, SCALE, feature("ferry"))).toThrow();
  });
});
