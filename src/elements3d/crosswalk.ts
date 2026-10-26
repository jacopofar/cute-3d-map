import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { MeshBuilder } from "./mesh_builder";

/*
 * Zebra crossings: flat white bars on the carriageway, long along the traffic
 * direction and repeated across the road. tilegen matches each
 * `highway=crossing` node to its road way and carries the local bearing and the
 * full road width; the frontend only lays the stripes.
 *
 * The marking is part of the street surface, not an object: one merged mesh per
 * tile, no shadows and no toggle. The stripes are two triangles each, so a dense
 * centre still stays cheap. They sit a few centimetres above the basemap to
 * avoid z-fighting, and follow the scene lighting so they do not bloom at night.
 */

const STRIPE_WIDTH = 0.65;
const STRIPE_GAP = 0.45;
const CROSSING_DEPTH = 3.0;
const LIFT = 0.046;
const OUTLINE_LIFT = 0.04;
const OUTLINE = 0.07;
const WHITE = new THREE.Color("#ffffff");
const WORN = new THREE.Color("#f2f2f2");
const OUTLINE_COLOR = new THREE.Color("#4c4c48");

// Lambert, not Basic: unlit pure white was brighter than the night scene and
// bloomed. Lit paint goes dark with the city; daylight still reads white.
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
  const pitch = STRIPE_WIDTH + STRIPE_GAP;
  // an odd count puts one bar on the crossing node, so the whole zebra is
  // clickable from its centre
  let count = Math.max(3, Math.round(width / pitch));
  if (count % 2 === 0) count += 1;
  count = Math.min(count, 15);
  const halfDepth = CROSSING_DEPTH / 2;
  const halfStripe = STRIPE_WIDTH / 2;

  const radians = (bearing * Math.PI) / 180;
  // u runs along the road; v crosses it. The bars are long in u (the traffic
  // direction) and repeat in v, across the carriageway. That is a zebra: a
  // pedestrian walking across the road steps over the bars.
  const ux = Math.sin(radians);
  const uy = Math.cos(radians);
  const vx = Math.cos(radians);
  const vy = -Math.sin(radians);

  const bars = new MeshBuilder();

  for (let i = 0; i < count; i++) {
    const offset = (i - (count - 1) / 2) * pitch;
    const cx = x + vx * offset;
    const cy = y + vy * offset;
    const c = i % 3 === 1 ? WORN : WHITE;
    const addBar = (
      depth: number,
      stripe: number,
      color: THREE.Color,
      z: number,
    ) => {
      // a = -u,-v, b = +u,-v, c = +u,+v, d = -u,+v; the builder corrects the
      // winding, which depends on the road bearing because the (u, v) frame is
      // left-handed in world XY
      bars.quad(
        [cx - ux * depth - vx * stripe, cy - uy * depth - vy * stripe, z],
        [cx + ux * depth - vx * stripe, cy + uy * depth - vy * stripe, z],
        [cx + ux * depth + vx * stripe, cy + uy * depth + vy * stripe, z],
        [cx - ux * depth + vx * stripe, cy - uy * depth + vy * stripe, z],
        [0, 0, 1],
        color,
      );
    };
    // A slightly larger dark edge keeps the white paint readable on the pale
    // basemap roads, without tinting the bars themselves.
    addBar(
      halfDepth + OUTLINE,
      halfStripe + OUTLINE,
      OUTLINE_COLOR,
      OUTLINE_LIFT,
    );
    addBar(halfDepth, halfStripe, c, LIFT);
  }

  const painted = bars.geometry();
  return painted ? [painted] : [];
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
