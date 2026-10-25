// Lane paint as maths: where the dividers sit across a carriageway, and how a
// dashed line breaks into segments along a polyline. Kept free of THREE (and of
// any projection) so it can be unit-tested like the facade and tombstone
// layouts; `lane.ts` turns the segments into geometry.

export interface Divider {
  /** meters from the centreline, positive to the left of the way's direction */
  offset: number;
  /** a dashed interior edge, or the solid centre of a two-way road */
  dashed: boolean;
}

export interface Segment {
  a: [number, number];
  b: [number, number];
}

// the classic urban dash: long enough to read at the zoom where paint appears,
// short enough that a junction still looks like a junction
export const DASH_LENGTH = 3;
export const DASH_GAP = 6;
// a dash shorter than this is a speck at the end of a tile-clipped line
const MIN_DASH = 0.4;

// Which dividers a carriageway gets. One-way roads get one dashed line per lane
// edge; a two-way road gets a solid centre, and a dashed edge inside each
// direction once there is more than one lane that way.
export function dividers(
  width: number,
  lanes: number,
  oneway: boolean,
): Divider[] {
  if (!Number.isFinite(width) || width <= 0) return [];
  const count = Math.min(Math.max(Math.round(lanes), 0), 8);
  if (count < 2) return [];
  const laneWidth = width / count;
  if (oneway) {
    const out: Divider[] = [];
    for (let i = 1; i < count; i++) {
      out.push({ offset: -width / 2 + i * laneWidth, dashed: true });
    }
    return out;
  }
  // two-way: the centre is solid, and an even split gives each direction
  // `count / 2` lanes; an odd count keeps a single centre lane, so only the
  // centre line is drawn (a turning lane is not a lane edge)
  const out: Divider[] = [{ offset: 0, dashed: false }];
  const perSide = Math.floor(count / 2);
  for (let k = 1; k < perSide; k++) {
    out.push({ offset: k * laneWidth, dashed: true });
    out.push({ offset: -k * laneWidth, dashed: true });
  }
  return out;
}

// Shift a polyline sideways by `offset`, using the average direction at each
// vertex so a curve does not tear. Positive is to the left of travel.
export function offsetLine(
  points: [number, number][],
  offset: number,
): [number, number][] {
  if (offset === 0) return points.map((p) => [p[0], p[1]]);
  const out: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    const [px, py] = points[Math.max(0, i - 1)];
    const [nx, ny] = points[Math.min(points.length - 1, i + 1)];
    let dx = nx - px;
    let dy = ny - py;
    const length = Math.hypot(dx, dy);
    if (length === 0) {
      out.push([points[i][0], points[i][1]]);
      continue;
    }
    dx /= length;
    dy /= length;
    out.push([points[i][0] - dy * offset, points[i][1] + dx * offset]);
  }
  return out;
}

// Break a polyline into dash segments, carrying the dash phase across the
// vertices so the pattern does not restart at every corner.
export function dashes(
  points: [number, number][],
  dash: number = DASH_LENGTH,
  gap: number = DASH_GAP,
): Segment[] {
  const out: Segment[] = [];
  const period = dash + gap;
  if (period <= 0) return out;
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const length = Math.hypot(bx - ax, by - ay);
    if (length === 0) continue;
    const at = (distance: number): [number, number] => [
      ax + ((bx - ax) * distance) / length,
      ay + ((by - ay) * distance) / length,
    ];
    let pos = 0;
    while (pos < length) {
      const phase = (travelled + pos) % period;
      if (phase >= dash) {
        pos += period - phase;
        continue;
      }
      const take = Math.min(dash - phase, length - pos);
      if (take >= MIN_DASH) out.push({ a: at(pos), b: at(pos + take) });
      pos += take;
    }
    travelled += length;
  }
  return out;
}

// A solid line: one segment per polyline edge.
export function solid(points: [number, number][]): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    out.push({ a: points[i - 1], b: points[i] });
  }
  return out;
}
