import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../geojson_data";
import { BoxBuilder } from "./box_builder";

/*
 * Low walls from `barrier=wall`/`retaining_wall`/`city_wall`/`hoarding` and
 * `wall=*` ways. A solid box per segment, one merged Lambert mesh per tile
 * (kind `wall`); no shadows.
 */

const DEFAULT_HEIGHT = 1.5;
const THICKNESS = 0.3;

const COLORS: Record<string, string> = {
  brick: "#9a6f57",
  stone: "#a7a196",
  concrete: "#a9a49b",
  dry_stone: "#a7a196",
  noise_barrier: "#8d938f",
  jersey_barrier: "#a9a49b",
};
const DEFAULT_COLOR = "#9d978c";

export const wallMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

type Point = [number, number];

export function wall(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const geom = f.geometry;
  const lines =
    geom.type === "LineString"
      ? [geom.coordinates]
      : geom.type === "MultiLineString"
        ? geom.coordinates
        : [];
  const props = f.properties ?? {};
  const height = Math.min(
    Math.max(Number(props.height) || DEFAULT_HEIGHT, 0.5),
    4,
  );
  const color = new THREE.Color(
    COLORS[String(props.wall ?? "")] ?? DEFAULT_COLOR,
  );
  const builder = new BoxBuilder();
  for (const line of lines) {
    const points: Point[] = line.map(([lon, lat]) =>
      toModelCoords([lon, lat], originMeters, scaleFactor),
    );
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) continue;
      // width is the wall thickness, depth follows the wall line
      builder.box(
        (a[0] + b[0]) / 2,
        (a[1] + b[1]) / 2,
        0,
        THICKNESS,
        length,
        height,
        Math.atan2(dx, -dy),
        color,
      );
    }
  }
  const geometry = builder.geometry();
  return geometry ? [geometry] : [];
}
