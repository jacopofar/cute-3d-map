// Collision geometry for car mode. Everything is in lon/lat, the same space as
// the tile features, so a projection origin reset never invalidates it. Pure
// (no Three.js/MapLibre) and unit-tested in collision.test.ts.
//
// The car is a rectangle, not a point: it stops when any part of the body
// touches a building footprint or a fence/wall line. A point test would let the
// paint sink into a wall by half a car width, which is very visible at the
// chase-camera zoom.

export type Point = [number, number];
// west, south, east, north
export type Box = [number, number, number, number];

export interface CarRect {
  // front-right, front-left, rear-left, rear-right
  corners: [Point, Point, Point, Point];
  // the rectangle's bounds, for the cheap reject before the edge tests
  box: Box;
}

const METERS_PER_DEGREE_LAT = 111_320;
// cross products of degree-sized differences are tiny; this is a floating-point
// slop, not a physical tolerance
const EPS = 1e-12;

export function boxOfPoints(points: Point[]): Box {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}

// touching counts as overlap: a bbox that merely grazes the car cannot hide a
// footprint that does intersect it
export function boxesOverlap(a: Box, b: Box): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

// ray-cast point-in-polygon; works for either winding
export function pointInRing(ring: Point[], [lon, lat]: Point): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (
      a[1] > lat !== b[1] > lat &&
      lon < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function withinBox(a: Point, b: Point, p: Point): boolean {
  return (
    p[0] >= Math.min(a[0], b[0]) - EPS &&
    p[0] <= Math.max(a[0], b[0]) + EPS &&
    p[1] >= Math.min(a[1], b[1]) - EPS &&
    p[1] <= Math.max(a[1], b[1]) + EPS
  );
}

/** Segment intersection, endpoints and collinear overlap included. */
export function segmentsIntersect(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): boolean {
  const o1 = cross(a, b, c);
  const o2 = cross(a, b, d);
  const o3 = cross(c, d, a);
  const o4 = cross(c, d, b);
  if (
    ((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) &&
    ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))
  ) {
    return true;
  }
  if (Math.abs(o1) <= EPS && withinBox(a, b, c)) return true;
  if (Math.abs(o2) <= EPS && withinBox(a, b, d)) return true;
  if (Math.abs(o3) <= EPS && withinBox(c, d, a)) return true;
  if (Math.abs(o4) <= EPS && withinBox(c, d, b)) return true;
  return false;
}

/**
 * The car's footprint in lon/lat. `heading` is the same counter-clockwise angle
 * from east used by the vehicle bodies and the driving model; the margin is
 * added on every side so the paint does not graze the obstacle.
 */
export function carRectangle(
  lon: number,
  lat: number,
  heading: number,
  length: number,
  width: number,
  margin = 0,
): CarRect {
  // the local equirectangular scale is plenty over a few meters; the cos guard
  // only keeps the poles from dividing by zero
  const cosLat = Math.max(1e-6, Math.cos((lat * Math.PI) / 180));
  const metersPerLon = METERS_PER_DEGREE_LAT * cosLat;
  // unit vectors in degrees per meter: forward along the heading, left a
  // quarter turn ahead of it
  const forwardLon = Math.cos(heading) / metersPerLon;
  const forwardLat = Math.sin(heading) / METERS_PER_DEGREE_LAT;
  const leftLon = -Math.sin(heading) / metersPerLon;
  const leftLat = Math.cos(heading) / METERS_PER_DEGREE_LAT;
  const halfLength = length / 2 + margin;
  const halfWidth = width / 2 + margin;
  const at = (along: number, across: number): Point => [
    lon + along * forwardLon + across * leftLon,
    lat + along * forwardLat + across * leftLat,
  ];
  const corners: [Point, Point, Point, Point] = [
    at(halfLength, -halfWidth),
    at(halfLength, halfWidth),
    at(-halfLength, halfWidth),
    at(-halfLength, -halfWidth),
  ];
  return { corners, box: boxOfPoints(corners) };
}

/** Whether a straight segment touches the car rectangle. */
export function segmentIntersectsRect(
  a: Point,
  b: Point,
  rect: CarRect,
): boolean {
  const { corners } = rect;
  if (pointInRing(corners, a) || pointInRing(corners, b)) return true;
  for (let i = 0; i < 4; i++) {
    if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

/** Whether a polyline touches the car: a fence or a wall. */
export function lineIntersectsRect(points: Point[], rect: CarRect): boolean {
  if (points.length === 0) return false;
  if (points.length === 1) return pointInRing(rect.corners, points[0]);
  for (let i = 0; i < points.length - 1; i++) {
    if (segmentIntersectsRect(points[i], points[i + 1], rect)) return true;
  }
  return false;
}

/**
 * Whether a closed footprint touches or contains the car. A ring crossing an
 * edge and one ring/car containing the other are both collisions; a courtyard
 * (an inner ring) is not passed in here, so its hole stays drivable.
 */
export function ringIntersectsRect(ring: Point[], rect: CarRect): boolean {
  if (ring.length === 0) return false;
  const { corners } = rect;
  // one contains the other: a car corner in the building, or a building corner
  // in the car (a small shed), with no edge crossing in between
  if (pointInRing(ring, corners[0])) return true;
  if (pointInRing(corners, ring[0])) return true;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    for (let j = 0; j < 4; j++) {
      if (segmentsIntersect(a, b, corners[j], corners[(j + 1) % 4])) {
        return true;
      }
    }
  }
  return false;
}
