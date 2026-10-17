// Layout maths for the facade detail (window columns, floor rows, the door).
// Kept free of THREE and of any projection so it can be unit-tested directly;
// src/elements3d/facade.ts turns these spans into geometry.

export interface Span {
  start: number;
  width: number;
}

// mulberry32 — a tiny deterministic PRNG, so a building keeps the same windows
// across frames, reloads and origin resets without pulling in a dependency
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a, for a stable seed from a building's position
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const WINDOW_MIN_WIDTH = 0.9;
export const WINDOW_MAX_WIDTH = 1.7;
export const WINDOW_MIN_GAP = 0.7;
export const WINDOW_MAX_GAP = 2.4;
export const WINDOW_MARGIN = 0.5;

export const FLOOR_HEIGHT = 3.0;
export const WINDOW_HEIGHT = 1.6;
export const GROUND_CLEARANCE = 1.1;
export const ROOF_MARGIN = 0.25;
export const MAX_FLOORS = 14;

export const DOOR_WIDTH = 1.1;
export const DOOR_HEIGHT = 2.1;
export const DOOR_MARGIN = 0.4;

// Balconies sit on the floors above the ground, and only on buildings tall
// enough to have at least two of them.
export const BALCONY_MIN_FLOORS = 2;
// how often a window column is balconied at all, and how often a balconied
// column breaks the full stack
export const BALCONY_CHANCE = 0.15;
export const BALCONY_IRREGULAR_CHANCE = 0.1;
export const BALCONY_MIN_WIDTH = 1.6;
export const BALCONY_MAX_WIDTH = 2.4;
export const BALCONY_DEPTH = 0.9;
export const BALCONY_SLAB = 0.15;
export const BALCONY_RAILING = 1.0;

const between = (rng: () => number, lo: number, hi: number) =>
  lo + rng() * (hi - lo);

// Window columns along a facade of `length` metres. A seeded random start, gap
// and width keep two facades from lining up ("irregular"); the walk runs to the
// far margin, so a long facade gets as many windows as fit (no column cap —
// capping it left the far half of long facades bare).
export function facadeWindows(length: number, rng: () => number): Span[] {
  const spans: Span[] = [];
  if (length - 2 * WINDOW_MARGIN < WINDOW_MIN_WIDTH) return spans;
  let cursor = WINDOW_MARGIN + rng() * WINDOW_MAX_GAP;
  for (;;) {
    const width = between(rng, WINDOW_MIN_WIDTH, WINDOW_MAX_WIDTH);
    if (cursor + width > length - WINDOW_MARGIN) break;
    spans.push({ start: cursor, width });
    cursor += width + between(rng, WINDOW_MIN_GAP, WINDOW_MAX_GAP);
  }
  return spans;
}

// Floor rows from the ground up; `start` is the sill height and `width` the
// window height. The floor height wobbles a little per building, and a band
// that would poke through the roof is dropped.
export function floorBands(height: number, rng: () => number): Span[] {
  const bands: Span[] = [];
  const step = between(rng, FLOOR_HEIGHT * 0.9, FLOOR_HEIGHT * 1.1);
  let bottom = GROUND_CLEARANCE;
  while (bands.length < MAX_FLOORS) {
    if (bottom + WINDOW_HEIGHT > height - ROOF_MARGIN) break;
    bands.push({ start: bottom, width: WINDOW_HEIGHT });
    bottom += step;
  }
  return bands;
}

// Where the door sits along a facade of `length`: centred, as long as it fits
// with a little room at the corners.
export function doorSpan(length: number): Span | null {
  if (length < DOOR_WIDTH + 2 * DOOR_MARGIN) return null;
  return { start: (length - DOOR_WIDTH) / 2, width: DOOR_WIDTH };
}

// Which floor bands may carry a balcony: the ones above the ground floor, but
// only when the building has at least BALCONY_MIN_FLOORS of them. Returned as
// indices into the band list.
export function balconyBands(bands: Span[]): number[] {
  if (bands.length < BALCONY_MIN_FLOORS) return [];
  const indices: number[] = [];
  for (let i = 1; i < bands.length; i++) indices.push(i);
  return indices;
}

// Which floors of one window column get a balcony. Usually the whole column
// above the ground reads as one aligned stack; BALCONY_IRREGULAR_CHANCE of the
// time an irregular subset instead. An empty result means a bare column.
export function balconyColumn(floors: number[], rng: () => number): number[] {
  if (floors.length === 0 || rng() >= BALCONY_CHANCE) return [];
  if (rng() >= BALCONY_IRREGULAR_CHANCE) return floors;
  return floors.filter(() => rng() < 0.5);
}

// A balcony centred on a window column, a bit wider than the window. The width
// is seeded, and the span is pulled inside the facade's margin.
export function balconySpan(
  column: Span,
  length: number,
  rng: () => number,
): Span {
  const width = between(rng, BALCONY_MIN_WIDTH, BALCONY_MAX_WIDTH);
  const centre = column.start + column.width / 2;
  const start = Math.max(
    WINDOW_MARGIN,
    Math.min(centre - width / 2, length - WINDOW_MARGIN - width),
  );
  return { start, width };
}
