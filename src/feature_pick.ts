// Nearest-feature picking for the click popups. Pure (no Three.js/MapLibre):
// the merged per-tile mesh tells us the kind and tile, and this finds the
// specific point, line or area under the hit. Unit-tested in feature_pick.test.ts.

import { toModelCoords } from "./geojson_data";
import type { BarrierInfo, FeatureInfo } from "./geojson_data";

export interface PickPoint {
  x: number;
  y: number;
}

// ray-cast point-in-polygon, in model space
export function ringContains(
  ring: [number, number][],
  point: PickPoint,
  originMeters: [number, number],
  scaleFactor: number,
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = toModelCoords(ring[i], originMeters, scaleFactor);
    const b = toModelCoords(ring[j], originMeters, scaleFactor);
    const crosses =
      a[1] > point.y !== b[1] > point.y &&
      point.x < ((b[0] - a[0]) * (point.y - a[1])) / (b[1] - a[1]) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

// distance (m) from a model-space point to a ring, used as a picking fallback.
// With closed=false it measures to an open polyline instead (a waterway
// centreline), so the last point does not connect back to the first.
export function ringDistance(
  ring: [number, number][],
  point: PickPoint,
  originMeters: [number, number],
  scaleFactor: number,
  closed = true,
): number {
  let best = Infinity;
  const count = ring.length;
  const segments = closed ? count : count - 1;
  for (let i = 0; i < segments; i++) {
    const a = toModelCoords(ring[i], originMeters, scaleFactor);
    const b = toModelCoords(ring[(i + 1) % count], originMeters, scaleFactor);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t =
      len2 > 0
        ? Math.max(
            0,
            Math.min(1, ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / len2),
          )
        : 0;
    const px = a[0] + t * dx;
    const py = a[1] + t * dy;
    best = Math.min(best, Math.hypot(point.x - px, point.y - py));
  }
  return best;
}

/**
 * The nearest feature among `kinds` to a hit on a merged tile mesh. Points are
 * measured to their position, lines to their segments and areas by containment
 * (then by distance for a near miss). `limit` is in meters.
 */
export function featureAt(
  candidates: FeatureInfo[],
  kinds: string[],
  point: PickPoint,
  originMeters: [number, number],
  scaleFactor: number,
  limit: number,
): FeatureInfo | undefined {
  const wanted = new Set(kinds);
  let best: FeatureInfo | undefined;
  let bestDistance = limit;
  for (const info of candidates) {
    if (!wanted.has(info.kind)) continue;
    let distance = Infinity;
    if (info.lon !== undefined && info.lat !== undefined) {
      const m = toModelCoords([info.lon, info.lat], originMeters, scaleFactor);
      distance = Math.hypot(m[0] - point.x, m[1] - point.y);
    }
    for (const line of info.lines ?? []) {
      distance = Math.min(
        distance,
        ringDistance(line, point, originMeters, scaleFactor, false),
      );
    }
    for (const ring of info.rings ?? []) {
      distance = ringContains(ring, point, originMeters, scaleFactor)
        ? 0
        : Math.min(
            distance,
            ringDistance(ring, point, originMeters, scaleFactor),
          );
    }
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = info;
    }
  }
  return best;
}

/** The nearest fence or wall line to a hit, within `limit` meters. */
export function barrierAt(
  candidates: BarrierInfo[],
  point: PickPoint,
  originMeters: [number, number],
  scaleFactor: number,
  limit: number,
): BarrierInfo | undefined {
  let best: BarrierInfo | undefined;
  let bestDistance = limit;
  for (const barrier of candidates) {
    const distance = ringDistance(
      barrier.coords,
      point,
      originMeters,
      scaleFactor,
      false,
    );
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = barrier;
    }
  }
  return best;
}
