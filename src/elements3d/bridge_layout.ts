// Layout maths for bridges and tunnel portals. Kept free of THREE and of any
// projection so it can be unit-tested directly; src/elements3d/bridge.ts turns
// these numbers into geometry.
//
// A bridge way is raised into a slab (deck + parapets) whose two ends ramp back
// down to the ground, so the deck meets the basemap road instead of ending in
// mid-air. `layer` is only OSM ordering, not a height, so it is used as a coarse
// proxy: a plain `bridge=yes` (layer 1) sits one step above the road.

// full deck width in meters per road/rail class. The class comes from the tile
// (`highway`/`railway`); anything unknown gets the default.
export const BRIDGE_WIDTH: Record<string, number> = {
  motorway: 16,
  motorway_link: 10,
  trunk: 16,
  trunk_link: 10,
  primary: 15,
  primary_link: 9,
  secondary: 13,
  secondary_link: 8,
  tertiary: 11,
  tertiary_link: 7,
  residential: 9,
  unclassified: 9,
  living_street: 8,
  service: 7,
  pedestrian: 8,
  footway: 5,
  path: 4,
  cycleway: 5,
  steps: 4,
  rail: 8,
  railway: 8,
  tram: 7,
  subway: 7,
  light_rail: 7,
  narrow_gauge: 6,
};
export const DEFAULT_BRIDGE_WIDTH = 10;

// the slab thickness, the parapet height on both edges, and the ramp length at
// each end (clamped to half the bridge, so a short one just tapers)
export const BRIDGE_THICKNESS = 0.7;
export const PARAPET_HEIGHT = 0.9;
export const BRIDGE_RAMP = 15;

// the portal: a dark frame (two pillars + a lintel) around the opening, with the
// opening left empty so the dark interior reads through it
export const PORTAL_HEIGHT = 6;
export const PORTAL_OPENING_WIDTH = 0.6;
export const PORTAL_OPENING_HEIGHT = 0.75;
export const PORTAL_FRAME = 0.9;

export type Point2 = [number, number];
// a 3D model-space point, used only for the flat number arrays
type P3 = [number, number, number];

export function bridgeDeckWidth(transportClass: string | undefined): number {
  if (!transportClass) return DEFAULT_BRIDGE_WIDTH;
  return BRIDGE_WIDTH[transportClass] ?? DEFAULT_BRIDGE_WIDTH;
}

export function bridgeDeckHeight(layer: number): number {
  // a bridge with no usable layer is treated as layer 1, so it still floats;
  // the base is a touch above the ~4.5 m of a real overpass
  const step = Number.isFinite(layer) ? Math.max(1, layer) : 1;
  return Math.max(4, 4.5 * step);
}

// the deck's height above ground at `distance` along a bridge of `total`
// length: 0 at the very ends, `height` in the middle, a smooth ramp between.
export function rampHeight(
  distance: number,
  total: number,
  height: number,
  ramp: number = BRIDGE_RAMP,
): number {
  if (total <= 0) return height;
  const r = Math.min(ramp, total / 2);
  if (r <= 0) return height;
  const t = Math.min(distance, total - distance) / r;
  if (t <= 0) return 0;
  if (t >= 1) return height;
  // smoothstep, so the joins at both ends are not visible kinks
  return height * t * t * (3 - 2 * t);
}

// unit normals at each vertex, averaged over the two adjacent segments so a
// bend does not pinch the slab to nothing
export function unitNormals(points: Point2[]): Point2[] {
  const normals: Point2[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) {
      dx = 1;
      dy = 0;
    } else {
      dx /= len;
      dy /= len;
    }
    normals.push([-dy, dx]);
  }
  return normals;
}

function distancesAlong(points: Point2[]): number[] {
  const distances = [0];
  for (let i = 1; i < points.length; i++) {
    distances.push(
      distances[i - 1] +
        Math.hypot(
          points[i][0] - points[i - 1][0],
          points[i][1] - points[i - 1][1],
        ),
    );
  }
  return distances;
}

// a quad as two triangles (a, b, c) and (a, c, d)
function quad(out: number[], a: P3, b: P3, c: P3, d: P3): void {
  out.push(...a, ...b, ...c, ...a, ...c, ...d);
}

/**
 * The deck of a bridge line: a rectangular slab of `width` along `points`, with
 * a `parapet`-high wall on each edge and both ends ramped to the ground over
 * BRIDGE_RAMP meters. Returns flat xyz positions (no normals/colors: the caller
 * computes normals).
 */
export function deckSolid(
  points: Point2[],
  width: number,
  height: number,
  thickness: number = BRIDGE_THICKNESS,
  parapet: number = PARAPET_HEIGHT,
  ramp: number = BRIDGE_RAMP,
): number[] {
  if (points.length < 2) return [];
  const half = width / 2;
  const normals = unitNormals(points);
  const distances = distancesAlong(points);
  const total = distances[distances.length - 1];
  const sections = points.map((point, i) => ({
    point,
    normal: normals[i],
    z: rampHeight(distances[i], total, height, ramp),
  }));
  const corner = (
    section: { point: Point2; normal: Point2; z: number },
    side: number,
    up: number,
  ): P3 => [
    section.point[0] + section.normal[0] * side * half,
    section.point[1] + section.normal[1] * side * half,
    section.z + up,
  ];
  const out: number[] = [];
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i];
    const b = sections[i + 1];
    // the slab's four long faces
    quad(
      out,
      corner(a, 1, 0),
      corner(b, 1, 0),
      corner(b, -1, 0),
      corner(a, -1, 0),
    );
    quad(
      out,
      corner(a, 1, -thickness),
      corner(a, -1, -thickness),
      corner(b, -1, -thickness),
      corner(b, 1, -thickness),
    );
    quad(
      out,
      corner(a, 1, 0),
      corner(a, 1, -thickness),
      corner(b, 1, -thickness),
      corner(b, 1, 0),
    );
    quad(
      out,
      corner(a, -1, 0),
      corner(b, -1, 0),
      corner(b, -1, -thickness),
      corner(a, -1, -thickness),
    );
    // a parapet on each edge: a thin wall standing on the deck
    for (const side of [1, -1]) {
      quad(
        out,
        corner(a, side, 0),
        corner(b, side, 0),
        corner(b, side, parapet),
        corner(a, side, parapet),
      );
    }
  }
  // close both ends; the ramps make these nearly degenerate, but a short bridge
  // with a clamped ramp still wants the caps
  const first = sections[0];
  const last = sections[sections.length - 1];
  quad(
    out,
    corner(first, 1, 0),
    corner(first, -1, 0),
    corner(first, -1, -thickness),
    corner(first, 1, -thickness),
  );
  quad(
    out,
    corner(last, 1, 0),
    corner(last, -1, 0),
    corner(last, -1, -thickness),
    corner(last, 1, -thickness),
  );
  return out;
}

/**
 * The vertical walls of a deck footprint (`man_made=bridge`): one quad per edge
 * of the ring, from the ground up to `height`. The top face is triangulated by
 * the caller (THREE's earcut), so this stays pure.
 */
export function deckWalls(ring: Point2[], height: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    quad(
      out,
      [a[0], a[1], 0],
      [b[0], b[1], 0],
      [b[0], b[1], height],
      [a[0], a[1], height],
    );
  }
  return out;
}

// an axis-aligned box in a local frame (u along the tunnel, v across it, z up),
// added to `out` as 12 triangles
function pushBox(
  out: number[],
  centreV: number,
  halfV: number,
  zMin: number,
  zMax: number,
  angle: number,
  halfU: number,
): void {
  const u: Point2 = [Math.cos(angle), Math.sin(angle)];
  const v: Point2 = [-Math.sin(angle), Math.cos(angle)];
  const at = (su: number, sv: number, z: number): P3 => [
    su * halfU * u[0] + (centreV + sv * halfV) * v[0],
    su * halfU * u[1] + (centreV + sv * halfV) * v[1],
    z,
  ];
  const c = [
    at(-1, -1, zMin),
    at(1, -1, zMin),
    at(1, 1, zMin),
    at(-1, 1, zMin),
    at(-1, -1, zMax),
    at(1, -1, zMax),
    at(1, 1, zMax),
    at(-1, 1, zMax),
  ];
  const faces: [number, number, number][] = [
    [0, 1, 2],
    [0, 2, 3],
    [4, 6, 5],
    [4, 7, 6],
    [0, 4, 5],
    [0, 5, 1],
    [1, 5, 6],
    [1, 6, 2],
    [2, 6, 7],
    [2, 7, 3],
    [3, 7, 4],
    [3, 4, 0],
  ];
  for (const [a, b, cIdx] of faces) out.push(...c[a], ...c[b], ...c[cIdx]);
}

/**
 * A tunnel portal at `centre` (z = 0), facing along `angle`: two pillars and a
 * lintel forming a rectangular opening. The opening is left empty on purpose,
 * so the tunnel interior reads as a dark hole rather than a filled wall.
 */
export function portalSolid(
  centre: Point2,
  angle: number,
  width: number,
  height: number = PORTAL_HEIGHT,
): number[] {
  const openWidth = width * PORTAL_OPENING_WIDTH;
  const openHeight = height * PORTAL_OPENING_HEIGHT;
  const pillarHalf = (width - openWidth) / 4;
  const pillarCentre = (width + openWidth) / 4;
  const out: number[] = [];
  const halfU = PORTAL_FRAME / 2;
  // the local v axis is centred on `centre`, so offset the frame's origin
  const box = (centreV: number, halfV: number, zMin: number, zMax: number) => {
    const before = out.length;
    pushBox(out, centreV, halfV, zMin, zMax, angle, halfU);
    for (let i = before; i < out.length; i += 3) {
      out[i] += centre[0];
      out[i + 1] += centre[1];
    }
  };
  // two pillars and a lintel; the gap between them is the opening
  box(-pillarCentre, pillarHalf, 0, openHeight);
  box(pillarCentre, pillarHalf, 0, openHeight);
  box(0, width / 2, openHeight, height);
  return out;
}
