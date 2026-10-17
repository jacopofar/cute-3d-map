// The pure part of the traffic renderer: how a vehicle's drawn loop-time is
// nudged as it passes the signals/crossings on its route. Kept free of Three.js
// so it can be unit-tested (src/traffic_math.test.ts); see src/traffic.ts for
// the renderer that calls it.
//
// Everything here is cosmetic: the bump returns to zero on both sides, so the
// lap schedule (and the vehicle spacing) is unchanged and nothing waits.

// a run with its time keyframes; speed may vary along it
export interface PreparedRun {
  t0: number;
  t1: number;
  coords: [number, number][];
  times: number[];
}

// a signal/crossing the vehicle passes, with the loop-time width of each side of
// its bump (computed from the distances below and the local speed):
// `t` is the seconds into the loop's period, `axis` the travel direction there
// (0 E-W, 1 N-S), `brake`/`recover`/`near` the seconds it takes to cover
// CROSSING_BRAKE_M back, CROSSING_RECOVER_M on, and CROSSING_GREEN_M on.
export interface PreparedCrossing {
  t: number;
  axis: 0 | 1;
  brake: number;
  recover: number;
  near: number;
}

// The light is global and cosmetic: axis 0 (roughly E-W) is "green" while axis
// 1 (N-S) is "red", and the two swap every SIGNAL_GREEN_S seconds (a multiple
// of 8 s). It decides whether a vehicle slows for a crossing or eases through.
export const SIGNAL_GREEN_S = 8;

// TODO: in practice the slow-down is barely noticeable. The smootherstep dip
// only touches the floor briefly, about half the crossings are green (a mild
// nudge), and CROSSING_MIN_GAP_M thins the rest, so a car is below 0.8 of cruise
// for only ~10% of a lap. Tweak the constants below first (a smaller
// CROSSING_MIN_GAP_M overlaps more dips, a higher CROSSING_RECOVER_PEAK makes
// more crossings trigger, a lower CROSSING_BRAKE_TO goes deeper); making it
// clearly visible wants a plateau in the dip rather than this smooth shape.

// A red crossing: start slowing CROSSING_BRAKE_M before it, down to
// CROSSING_BRAKE_TO of cruise, and recover over CROSSING_RECOVER_M after it.
// The recovery distance is derived so the time lost slowing is regained
// exactly; CROSSING_RECOVER_PEAK is the speed factor at the middle of it.
export const CROSSING_BRAKE_M = 60;
export const CROSSING_BRAKE_TO = 0.05;
export const CROSSING_RECOVER_PEAK = 1.5;
export const CROSSING_RECOVER_M =
  (CROSSING_BRAKE_M * (1 - CROSSING_BRAKE_TO)) / (CROSSING_RECOVER_PEAK - 1);

// A green crossing: a gentle nudge the other way (1.0 turns it off).
export const CROSSING_GREEN_M = 60;
export const CROSSING_GREEN_PEAK = 1.05;

// two crossings closer than this are merged. Deliberately shorter than the bump
// itself: overlapping bumps add up, which deepens and lengthens a dense stretch
// of slow-downs (the merge is only to avoid a pointless pile-up).
export const CROSSING_MIN_GAP_M = 80;

// the maximum slope of smootherstep, used to size the bumps
const SMOOTH_PEAK = 1.875;

function smootherstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function haversineM(a: [number, number], b: [number, number]): number {
  const r = 6371000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180;
  const la2 = (b[1] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

// whether the light for `axis` is green at absolute time `seconds`
export function lightGreen(axis: number, seconds: number): boolean {
  const window = Math.floor(seconds / SIGNAL_GREEN_S);
  // normalize the modulo so a negative time still alternates correctly
  return ((window % 2) + 2) % 2 === axis;
}

// the travel axis (0 E-W, 1 N-S) at a point of the route
export function axisOf(
  before: [number, number],
  after: [number, number],
): 0 | 1 {
  const cosLat = Math.cos((((before[1] + after[1]) / 2) * Math.PI) / 180);
  const dx = Math.abs((after[0] - before[0]) * cosLat);
  const dy = Math.abs(after[1] - before[1]);
  return dx >= dy ? 0 : 1;
}

// the tile writes loop coordinates rounded to 7 decimals and the point features
// carry the raw node coordinate; keying both at ~10 cm makes them collide
export function coordKey(lon: number, lat: number): string {
  return `${Math.round(lon * 1e6)},${Math.round(lat * 1e6)}`;
}

// The signed shift (seconds) added to a vehicle's loop-time as it passes its
// crossings. On a red axis the vehicle slows over `brake` seconds, is back at
// cruise at the crossing and eases back over `recover`; on green it eases up and
// settles. Both are smooth bumps that return to zero, so the drawn speed never
// leaves (0, 2) and the lap schedule is untouched.
export function crossingShift(
  tau: number,
  crossings: PreparedCrossing[],
  now: number,
): number {
  let shift = 0;
  for (const crossing of crossings) {
    const d = tau - crossing.t;
    if (d < -crossing.brake || d > crossing.recover) continue;
    // the vehicle reaches the crossing at `now - d`, which is constant while it
    // passes through the bump (now - tau is fixed within a lap)
    if (lightGreen(crossing.axis, now - d)) {
      // green: ease up on the approach, settle after
      if (Math.abs(d) < crossing.near) {
        const l = ((CROSSING_GREEN_PEAK - 1) * crossing.near) / SMOOTH_PEAK;
        shift += l * (1 - smootherstep(Math.abs(d) / crossing.near));
      }
      continue;
    }
    // red: slow on the way in, recover on the way out
    const l = ((1 - CROSSING_BRAKE_TO) * crossing.brake) / SMOOTH_PEAK;
    const b =
      d <= 0
        ? smootherstep((d + crossing.brake) / crossing.brake)
        : 1 - smootherstep(d / crossing.recover);
    shift -= l * b;
  }
  return shift;
}

// flatten a loop's runs into one polyline with a loop-time per vertex, dropping
// the duplicated vertices where runs meet
function flattenRuns(runs: PreparedRun[]): {
  coords: [number, number][];
  times: number[];
} {
  const coords: [number, number][] = [];
  const times: number[] = [];
  for (const run of runs) {
    for (let i = 0; i < run.coords.length; i++) {
      const c = run.coords[i];
      const t = run.t0 + run.times[i];
      const last = coords[coords.length - 1];
      if (last && last[0] === c[0] && last[1] === c[1]) continue;
      coords.push(c);
      times.push(t);
    }
  }
  return { coords, times };
}

// seconds from vertex `i` to the point `distance` meters along `dir`, or to the
// end of the polyline if it runs out first
function timeFor(
  coords: [number, number][],
  times: number[],
  i: number,
  dir: 1 | -1,
  distance: number,
): number {
  let covered = 0;
  let j = i;
  for (;;) {
    const k = j + dir;
    if (k < 0 || k >= coords.length) return Math.abs(times[j] - times[i]);
    const step = haversineM(coords[j], coords[k]);
    if (covered + step >= distance) {
      const f = step > 0 ? (distance - covered) / step : 0;
      return Math.abs(times[j] + f * (times[k] - times[j]) - times[i]);
    }
    covered += step;
    j = k;
  }
}

// walk a loop's runs and keep the crossings that lie on its vertices, with the
// loop-time at each and the width of each side of its bump. Runs are sorted by
// t0, so the result is sorted by t.
export function crossingsAlongLoop(
  runs: PreparedRun[],
  keys: Set<string>,
): PreparedCrossing[] {
  const { coords, times } = flattenRuns(runs);
  const found: PreparedCrossing[] = [];
  let arc = 0;
  let lastArc = -Infinity;
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) arc += haversineM(coords[i - 1], coords[i]);
    const c = coords[i];
    if (!keys.has(coordKey(c[0], c[1]))) continue;
    if (arc - lastArc < CROSSING_MIN_GAP_M) continue;
    const before = coords[i - 1] ?? coords[i + 1] ?? c;
    const after = coords[i + 1] ?? coords[i - 1] ?? c;
    found.push({
      t: times[i],
      axis: axisOf(before, after),
      brake: timeFor(coords, times, i, -1, CROSSING_BRAKE_M),
      recover: timeFor(coords, times, i, 1, CROSSING_RECOVER_M),
      near: timeFor(coords, times, i, 1, CROSSING_GREEN_M),
    });
    lastArc = arc;
  }
  return found;
}
