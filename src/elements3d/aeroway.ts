import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { flatPolygon } from "./flat_polygon";
import { applyVertexColor } from "./vertex_color";

/*
 * Airport tarmac: runways and taxiways as flat ribbons, aprons and helipad
 * polygons as flat areas, all a hair above the ground. This is what makes the
 * plane paths legible over the basemap: a runway is drawn dark and a little
 * wider than the OSM width, so it still reads where MapTiler already paints its
 * own runway underneath.
 *
 * Like water, tilegen stores each aeroway feature whole, so a runway spanning
 * two loaded tiles is built twice; the surfaces are identical and coplanar, so
 * the overlap is invisible and there is nothing to dedupe here.
 */

// The movement-area surfaces all lie flat, but a taxiway meets a runway and an
// apron meets a taxiway: at the same z those coplanar overlaps z-fight, and the
// kinds have different colors, so it reads as flicker. Give each kind a fixed
// step (2 cm, as water and green use, is enough for this depth range). Runway is
// lowest, so a taxiway entrance and an apron edge draw over it.
const SURFACE_Z: Record<string, number> = {
  runway: 0.02,
  taxiway: 0.04,
  apron: 0.06,
  helipad: 0.08,
};
const DEFAULT_SURFACE_Z = 0.03;

export function surfaceZ(kind: string): number {
  return SURFACE_Z[kind] ?? DEFAULT_SURFACE_Z;
}

// full ribbon width in meters per aeroway class when OSM has no `width` tag
export const AEROWAY_WIDTH: Record<string, number> = {
  runway: 45,
  taxiway: 15,
};
export const DEFAULT_AEROWAY_WIDTH = 15;

// the surface tint per class: dark asphalt for the movement area, a lighter
// concrete gray for the apron. Muted on purpose: the basemap paints its own
// runway, so ours must sit under the eye rather than fight it.
const AEROWAY_COLORS: Record<string, string> = {
  runway: "#3a3d42",
  taxiway: "#474a50",
  apron: "#83868c",
  helipad: "#5a5d63",
};
const DEFAULT_AEROWAY_COLOR = "#4a4d52";

export function aerowayWidth(kind: string): number {
  return AEROWAY_WIDTH[kind] ?? DEFAULT_AEROWAY_WIDTH;
}

function aerowayColor(kind: string): THREE.Color {
  return new THREE.Color(AEROWAY_COLORS[kind] ?? DEFAULT_AEROWAY_COLOR);
}

// Every aeroway geometry has to carry the same attribute set (position, normal,
// color), or the per-tile merge returns null and the whole kind vanishes for
// that tile. The surfaces are horizontal, so the normal is straight up: this
// covers the ribbons too, which are built from raw positions.
function flatNormal(geometry: THREE.BufferGeometry): void {
  const count = geometry.getAttribute("position").count;
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) normals[i * 3 + 2] = 1;
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
}

// a polyline turned into a flat band, mirroring water's ribbon: each point is
// pushed half a width to either side of the centreline, with the offset taken
// from the average of the two adjacent segments so a bend does not pinch
function ribbonGeometry(
  coords: Geojson.Position[],
  halfWidth: number,
  originMeters: [number, number],
  scaleFactor: number,
  z: number,
): THREE.BufferGeometry | null {
  const points = coords.map((c) =>
    toModelCoords([c[0], c[1]], originMeters, scaleFactor),
  );
  if (points.length < 2) return null;
  const offsets: [number, number][] = [];
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
    offsets.push([-dy * halfWidth, dx * halfWidth]);
  }
  const positions: number[] = [];
  const push = (p: [number, number], o: [number, number], side: number) =>
    positions.push(p[0] + o[0] * side, p[1] + o[1] * side, z);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const oa = offsets[i];
    const ob = offsets[i + 1];
    push(a, oa, 1);
    push(a, oa, -1);
    push(b, ob, 1);
    push(a, oa, -1);
    push(b, ob, -1);
    push(b, ob, 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  return geometry;
}

/**
 * The tarmac geometries for one aeroway feature: one per area part, or one per
 * line part, all flat above the ground with a baked tint.
 */
export function aeroway(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const props = f.properties ?? {};
  const kind = typeof props.aeroway === "string" ? props.aeroway : "";
  const color = aerowayColor(kind);
  const width =
    Number(props.width) > 0 ? Number(props.width) : aerowayWidth(kind);
  const z = surfaceZ(kind);
  const geometries: THREE.BufferGeometry[] = [];

  const finish = (geometry: THREE.BufferGeometry | null) => {
    if (!geometry) return;
    flatNormal(geometry);
    applyVertexColor(geometry, color);
    geometries.push(geometry);
  };

  const g = f.geometry;
  if (g.type === "Polygon")
    finish(flatPolygon(g.coordinates, originMeters, scaleFactor, { z }));
  else if (g.type === "MultiPolygon")
    g.coordinates.forEach((polygon) =>
      finish(flatPolygon(polygon, originMeters, scaleFactor, { z })),
    );
  else if (g.type === "LineString")
    finish(
      ribbonGeometry(g.coordinates, width * 0.5, originMeters, scaleFactor, z),
    );
  else if (g.type === "MultiLineString")
    g.coordinates.forEach((line) =>
      finish(ribbonGeometry(line, width * 0.5, originMeters, scaleFactor, z)),
    );

  return geometries;
}

// one shared material for the whole kind. Lambert (not Basic) so the tarmac
// shades with the sun like the trees; the normals are baked straight up above.
export const aerowayMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});
