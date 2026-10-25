import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import {
  DASH_GAP,
  DASH_LENGTH,
  dashes,
  dividers,
  offsetLine,
  solid,
} from "./lane_layout";

// Lane paint sits above the green and the water planes and below the sidewalk
// slabs (0.14 m), so it reads as a marking on the road rather than a kerb.
const LANE_Z = 0.04;

// The paint is drawn as lines rather than quads: a dash is two vertices instead
// of six, which matters when a busy tile carries a few thousand of them, and a
// 1 px line reads correctly as paint at the zooms the layer appears at.
export const laneMaterial = new THREE.LineBasicMaterial({
  color: 0xf2f2ee,
  transparent: true,
  opacity: 0.7,
  depthWrite: false,
});

function lineParts(f: Geojson.Feature): Geojson.Position[][] {
  if (f.geometry.type === "LineString") return [f.geometry.coordinates];
  if (f.geometry.type === "MultiLineString") return f.geometry.coordinates;
  return [];
}

/**
 * The lane dividers of one tile-clipped road, as one LineSegments geometry:
 * a solid centre for a two-way road and a dash pattern per interior lane edge.
 * The road itself comes from the basemap, so this is paint only.
 */
export function lane(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const props = f.properties as {
    width?: unknown;
    lanes?: unknown;
    oneway?: unknown;
  } | null;
  const width = Number(props?.width);
  const lanes = Number(props?.lanes);
  if (!Number.isFinite(width) || !Number.isFinite(lanes)) return [];

  const layout = dividers(width, lanes, Boolean(props?.oneway));
  if (layout.length === 0) return [];

  const positions: number[] = [];
  for (const part of lineParts(f)) {
    const points = part.map((c) =>
      toModelCoords(
        [c[0], c[1]] as [number, number],
        originMeters,
        scaleFactor,
      ),
    );
    if (points.length < 2) continue;
    for (const divider of layout) {
      const shifted = offsetLine(points, divider.offset);
      const segments = divider.dashed
        ? dashes(shifted, DASH_LENGTH, DASH_GAP)
        : solid(shifted);
      for (const { a, b } of segments) {
        positions.push(a[0], a[1], LANE_Z, b[0], b[1], LANE_Z);
      }
    }
  }
  if (positions.length === 0) return [];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  return [geometry];
}
