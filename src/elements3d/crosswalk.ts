import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../geojson_data";

/*
 * Zebra crossings: flat white bars on the carriageway, oriented across the road.
 * tilegen matches each `highway=crossing` node to its road way and carries the
 * local bearing and the full road width; the frontend only lays the stripes.
 *
 * The marking is part of the street surface, not an object: one merged mesh per
 * tile, no shadows and no toggle. The stripes are two triangles each, so a dense
 * centre still stays cheap. They sit a few centimetres above the basemap to
 * avoid z-fighting, and are unlit enough to read at dusk (Lambert, like the
 * rest).
 */

const STRIPES = 5;
const STRIPE_WIDTH = 0.5;
const STRIPE_GAP = 0.55;
const LIFT = 0.045;
const WHITE = new THREE.Color("#e9e5da");
const WORN = new THREE.Color("#d9d5c9");

export const crosswalkMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

export interface CrosswalkInfo {
  id?: string;
  lon: number;
  lat: number;
  crossing?: string;
  markings?: string;
}

/** The stripe geometry for one marked crossing, or null when it has no road
 * bearing (the traffic layer still keeps the plain crossing point). */
export function crosswalk(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const geometry = f.geometry;
  const props = f.properties ?? {};
  if (geometry.type !== "Point") return [];
  const bearing = Number(props.bearing);
  if (!Number.isFinite(bearing)) return [];

  const [x, y] = toModelCoords(
    geometry.coordinates as [number, number],
    originMeters,
    scaleFactor,
  );
  const width = Math.min(Math.max(Number(props.width) || 7, 3.5), 20);
  const depth = STRIPES * STRIPE_WIDTH + (STRIPES - 1) * STRIPE_GAP;
  const half = width / 2;

  const radians = (bearing * Math.PI) / 180;
  // u runs along the road, v across it; the bars are long in v and repeat in u
  const ux = Math.sin(radians);
  const uy = Math.cos(radians);
  const vx = Math.cos(radians);
  const vy = -Math.sin(radians);

  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const color: number[] = [];

  const push = (
    px: number,
    py: number,
    u: number,
    w: number,
    c: THREE.Color,
  ) => {
    position.push(px, py, LIFT);
    normal.push(0, 0, 1);
    uv.push(u, w);
    color.push(c.r, c.g, c.b);
  };

  for (let i = 0; i < STRIPES; i++) {
    const offset =
      -depth / 2 + STRIPE_WIDTH / 2 + i * (STRIPE_WIDTH + STRIPE_GAP);
    const cx = x + ux * offset;
    const cy = y + uy * offset;
    const c = i % 3 === 1 ? WORN : WHITE;
    // a = -v,-u, b = +v,-u, c = +v,+u, d = -v,+u (counter-clockwise from +z)
    const ax = cx - vx * half - ux * (STRIPE_WIDTH / 2);
    const ay = cy - vy * half - uy * (STRIPE_WIDTH / 2);
    const bx = cx + vx * half - ux * (STRIPE_WIDTH / 2);
    const by = cy + vy * half - uy * (STRIPE_WIDTH / 2);
    const cx2 = cx + vx * half + ux * (STRIPE_WIDTH / 2);
    const cy2 = cy + vy * half + uy * (STRIPE_WIDTH / 2);
    const dx = cx - vx * half + ux * (STRIPE_WIDTH / 2);
    const dy = cy - vy * half + uy * (STRIPE_WIDTH / 2);
    push(ax, ay, 0, 0, c);
    push(bx, by, 1, 0, c);
    push(cx2, cy2, 1, 1, c);
    push(ax, ay, 0, 0, c);
    push(cx2, cy2, 1, 1, c);
    push(dx, dy, 0, 1, c);
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  out.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  out.setAttribute("color", new THREE.Float32BufferAttribute(color, 3));
  return [out];
}

/** The crossing points in a tile, for click-picking. */
export function crosswalkInfo(f: Geojson.Feature): CrosswalkInfo | null {
  if (f.geometry.type !== "Point") return null;
  const props = f.properties ?? {};
  const [lon, lat] = f.geometry.coordinates as [number, number];
  return {
    id: typeof f.id === "string" ? f.id : undefined,
    lon,
    lat,
    crossing: typeof props.crossing === "string" ? props.crossing : undefined,
    markings: typeof props.markings === "string" ? props.markings : undefined,
  };
}
