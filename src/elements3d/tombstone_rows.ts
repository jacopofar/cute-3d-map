/*
 * Procedural rows of tombstones inside a cemetery polygon.
 *
 * OSM maps the cemetery area but almost never the individual graves, so the
 * frontend lays them out itself: a grid aligned to the longest boundary edge,
 * with a margin from the wall, a seeded gap pattern so it does not read as a
 * chessboard, and a cap that keeps a huge cemetery from turning one tile into
 * a million triangles. The layout is pure and in meters, so it is unit-tested
 * like the facade and roof layouts.
 */

export interface TombstoneSpot {
  x: number;
  y: number;
  // the slab's local +x (its width) after this rotation, so it faces along the
  // row like a headstone facing the path
  angle: number;
  // 0 is a cross; the other values pick one of the slab heights/colors
  kind: number;
}

export interface TombstoneOptions {
  // spacing between rows and between stones in a row, meters
  rowSpacing?: number;
  stoneSpacing?: number;
  // how far from the wall the first row starts
  edgeMargin?: number;
  // hard cap for one cemetery polygon; huge cemeteries get wider spacing
  maxStones?: number;
  seed?: number;
}

const DEFAULTS = {
  rowSpacing: 2.8,
  stoneSpacing: 2.2,
  edgeMargin: 1.2,
  maxStones: 9000,
  seed: 0,
};

type Point = [number, number];
type Ring = Point[];

function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentDistance(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq > 0
      ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq))
      : 0;
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
}

// within `margin` of any boundary segment, outer or hole
function nearBoundary(x: number, y: number, rings: Ring[], margin: number) {
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if (
        segmentDistance(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]) <
        margin
      ) {
        return true;
      }
    }
  }
  return false;
}

// the longest boundary edge gives the row direction; most cemeteries are
// laid out along the wall, so this follows the site instead of north-up rows
function longestEdge(ring: Ring): { ux: number; uy: number } {
  let best = 0;
  let ux = 1;
  let uy = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const dx = ring[j][0] - ring[i][0];
    const dy = ring[j][1] - ring[i][1];
    const length = dx * dx + dy * dy;
    if (length > best) {
      best = length;
      const inv = 1 / Math.sqrt(length);
      ux = dx * inv;
      uy = dy * inv;
    }
  }
  return { ux, uy };
}

function ringArea(ring: Ring): number {
  let twice = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    twice += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return Math.abs(twice) / 2;
}

function hash2(i: number, j: number, seed: number): number {
  let h =
    Math.imul(i | 0, 374761393) ^
    Math.imul(j | 0, 668265263) ^
    Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Positions for the tombstones of one cemetery polygon (the first ring is the
 * outline, the rest are holes), in the same model-space meters as the input.
 * Rows run along the longest edge; the cap stretches the spacing rather than
 * leaving holes in the rows.
 */
export function tombstoneSpots(
  rings: Ring[],
  options: TombstoneOptions = {},
): TombstoneSpot[] {
  if (rings.length === 0 || rings[0].length < 3) return [];
  const rowSpacing0 = options.rowSpacing ?? DEFAULTS.rowSpacing;
  const stoneSpacing0 = options.stoneSpacing ?? DEFAULTS.stoneSpacing;
  const edgeMargin = options.edgeMargin ?? DEFAULTS.edgeMargin;
  const maxStones = options.maxStones ?? DEFAULTS.maxStones;
  const seed = options.seed ?? DEFAULTS.seed;

  const outer = rings[0];
  const { ux, uy } = longestEdge(outer);
  // v is the row normal; (u, v) is an orthonormal frame
  const vx = -uy;
  const vy = ux;
  const toUV = (p: Point): Point => [
    p[0] * ux + p[1] * uy,
    p[0] * vx + p[1] * vy,
  ];
  const uvRings = rings.map((ring) => ring.map(toUV));

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const [u, v] of uvRings[0]) {
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  const spanU = maxU - minU;
  const spanV = maxV - minV;
  if (spanU <= 0 || spanV <= 0) return [];

  // A huge cemetery would need tens of thousands of stones. Stretch both
  // spacings so the rows stay contiguous (an occupancy-only cap would leave a
  // field of isolated dots), then keep a hard cap as the final guard. Use the
  // polygon area, not the bounding box: an elongated or concave cemetery would
  // otherwise look much sparser than its walled area.
  let area = ringArea(outer);
  for (let h = 1; h < rings.length; h++) area -= ringArea(rings[h]);
  const estimated = Math.max(0, area) / (rowSpacing0 * stoneSpacing0);
  const targetCells = maxStones / 0.62;
  const stretch = Math.max(1, Math.sqrt(estimated / targetCells));
  const rowSpacing = rowSpacing0 * stretch;
  const stoneSpacing = stoneSpacing0 * stretch;

  const spots: TombstoneSpot[] = [];
  const angle = Math.atan2(uy, ux) + Math.PI / 2;
  let row = 0;
  for (let v = minV + rowSpacing / 2; v <= maxV; v += rowSpacing, row++) {
    let column = 0;
    for (
      let u = minU + stoneSpacing / 2;
      u <= maxU;
      u += stoneSpacing, column++
    ) {
      const jitterU = (hash2(row, column, seed) - 0.5) * 0.08 * stoneSpacing;
      const jitterV = (hash2(row, column, seed + 1) - 0.5) * 0.08 * rowSpacing;
      const x = (u + jitterU) * ux + (v + jitterV) * vx;
      const y = (u + jitterU) * uy + (v + jitterV) * vy;
      if (!pointInRing(x, y, outer)) continue;
      let inHole = false;
      for (let h = 1; h < rings.length; h++) {
        if (pointInRing(x, y, rings[h])) {
          inHole = true;
          break;
        }
      }
      if (inHole) continue;
      if (nearBoundary(x, y, rings, edgeMargin)) continue;
      // a seeded gap pattern keeps the rows from reading as a solid block
      if (hash2(row, column, seed + 2) > 0.85) continue;
      spots.push({
        x,
        y,
        angle,
        kind:
          hash2(row, column, seed + 3) < 0.1
            ? 0
            : 1 + (hash2(row, column, seed + 4) % 5),
      });
      if (spots.length >= maxStones) return spots;
    }
  }
  return spots;
}

export { pointInRing, nearBoundary, longestEdge };
