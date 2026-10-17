// Layout maths for building roofs. Kept free of THREE and of any projection so
// it can be unit-tested directly; src/elements3d/roof.ts turns it into geometry.
//
// A footprint gets one ridge, run along its longest edge: a gable reaches both
// ends, a hip is pulled in, a pyramid collapses the ridge to a point. Every
// eave edge then connects to its ridge point, which reproduces all four shapes
// from the same walk.

export const ROOF_KINDS = ["flat", "gabled", "hipped", "pyramidal"] as const;
export type RoofKind = (typeof ROOF_KINDS)[number];

// the footprint's own frame: `axis` runs along the ridge, `acrossCentre` is the
// middle of the footprint across it
export interface RoofFrame {
  axis: [number, number];
  alongMin: number;
  alongMax: number;
  acrossCentre: number;
  width: number;
}

export interface PreparedRoof {
  kind: Exclude<RoofKind, "flat">;
  frame: RoofFrame;
  ridgeMin: number;
  ridgeMax: number;
  rise: number;
}

// at least this much longer than wide, and the building gets a gable
export const GABLE_ASPECT = 1.6;
// big blocks stay flat, however they are shaped
export const FLAT_AREA = 500;
// small and squarish reads as a pyramid; wider squarish ones get a hip
export const PYRAMID_WIDTH = 9;
// seeded "surprise": this fraction of buildings pick any kind, shape aside
export const ROOF_VARIETY = 0.2;

export const MIN_RISE = 0.8;
export const MAX_RISE = 6;
export const RISE_PER_WIDTH = 0.45;

// A footprint with more outline than this is "complex": its eave edges are no
// longer a clean ring round the building, so it gets a flat roof and no pitched
// geometry at all.
export const MAX_ROOF_VERTICES = 8;

export function polygonArea(ring: [number, number][]): number {
  let doubled = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    doubled += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(doubled) / 2;
}

// every turn is the same way round (collinear points are fine)
export function isConvex(ring: [number, number][]): boolean {
  const n = ring.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const c = ring[(i + 2) % n];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-12) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// corners of a ring, ignoring a repeated closing vertex
export function ringCorners(ring: [number, number][]): number {
  if (
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
  ) {
    return ring.length - 1;
  }
  return ring.length;
}

// The outline a roof may be built over: the ring itself, or null when the
// footprint is too complex to roof and should stay flat. The ridge fan only
// gives a clean surface over a convex ring, so a concave footprint — or one with
// more corners than MAX_ROOF_VERTICES — is left flat.
export function roofOutline(
  ring: [number, number][],
): [number, number][] | null {
  if (ring.length < 3) return null;
  if (ringCorners(ring) > MAX_ROOF_VERTICES) return null;
  return isConvex(ring) ? ring : null;
}

// the direction of the ring's longest edge, normalised. Long buildings are the
// common case, and their longest wall is their long axis.
export function ridgeAxis(ring: [number, number][]): [number, number] {
  let best: [number, number] = [1, 0];
  let bestLength = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length > bestLength) {
      bestLength = length;
      best = [dx / length, dy / length];
    }
  }
  return best;
}

export function roofFrame(ring: [number, number][]): RoofFrame {
  const axis = ridgeAxis(ring);
  let alongMin = Infinity;
  let alongMax = -Infinity;
  let acrossMin = Infinity;
  let acrossMax = -Infinity;
  for (const [x, y] of ring) {
    const along = x * axis[0] + y * axis[1];
    const across = -x * axis[1] + y * axis[0];
    alongMin = Math.min(alongMin, along);
    alongMax = Math.max(alongMax, along);
    acrossMin = Math.min(acrossMin, across);
    acrossMax = Math.max(acrossMax, across);
  }
  return {
    axis,
    alongMin,
    alongMax,
    acrossCentre: (acrossMin + acrossMax) / 2,
    width: acrossMax - acrossMin,
  };
}

// frame coordinates -> model coordinates
export function frameToWorld(
  frame: RoofFrame,
  along: number,
  across: number,
): [number, number] {
  const [ax, ay] = frame.axis;
  return [along * ax - across * ay, along * ay + across * ax];
}

// Pick a shape from the footprint: long and narrow gables, squarish small ones
// pyramid, big blocks stay flat, and a seeded fraction surprises.
export function chooseRoofKind(
  length: number,
  width: number,
  area: number,
  rng: () => number,
): RoofKind {
  if (rng() < ROOF_VARIETY) {
    return ROOF_KINDS[Math.floor(rng() * ROOF_KINDS.length)];
  }
  if (width <= 0) return "flat";
  if (length / width >= GABLE_ASPECT) return "gabled";
  if (area >= FLAT_AREA) return "flat";
  if (width <= PYRAMID_WIDTH) return "pyramidal";
  return "hipped";
}

// ridge height, from the footprint's narrow side so the pitch stays sane
export function roofRise(width: number): number {
  return Math.min(MAX_RISE, Math.max(MIN_RISE, RISE_PER_WIDTH * width));
}

// How far the ridge runs along the axis: a gable reaches both ends (its ends
// are vertical walls), a hip is pulled in, a pyramid collapses to a point.
export function ridgeExtent(
  kind: RoofKind,
  min: number,
  max: number,
  width: number,
): [number, number] {
  if (kind === "gabled") return [min, max];
  if (kind === "pyramidal") {
    const centre = (min + max) / 2;
    return [centre, centre];
  }
  const inset = Math.min(0.5 * width, 0.5 * (max - min));
  return [min + inset, max - inset];
}

// the whole roof plan for one footprint, or null when it stays flat
export function roofPlan(
  ring: [number, number][],
  rng: () => number,
): PreparedRoof | null {
  const frame = roofFrame(ring);
  const length = frame.alongMax - frame.alongMin;
  const kind = chooseRoofKind(length, frame.width, polygonArea(ring), rng);
  if (kind === "flat") return null;
  const [ridgeMin, ridgeMax] = ridgeExtent(
    kind,
    frame.alongMin,
    frame.alongMax,
    frame.width,
  );
  return { kind, frame, ridgeMin, ridgeMax, rise: roofRise(frame.width) };
}
