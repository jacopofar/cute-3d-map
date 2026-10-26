import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import {
  coloured,
  mergeParts,
  placeAt,
  propBox,
  propCylinder,
  quarterTurn,
} from "./props";

/*
 * Playgrounds: a sand/rubber patch with a swing, a slide, a spring rider and,
 * when the mapped area is wide enough, a climbing frame. tilegen emits one point
 * with a size (the equivalent diameter of the polygon, clamped); the equipment
 * is procedural and seeded, merged into one Lambert mesh per tile.
 *
 * No shadows: the pieces are small, and the layer is already a lot of triangles
 * if every playground in the window is loaded.
 */

const SAND = new THREE.Color("#d8c29a");
const BORDER = new THREE.Color("#a56a3a");
const METAL = new THREE.Color("#4c7a9a");
const SLIDE = new THREE.Color("#d14a3a");
const SEAT = new THREE.Color("#e8b13a");
const CLIMB = new THREE.Color("#4d8a4a");
const SPRING = new THREE.Color("#c46a2a");

export const PLAYGROUND_MIN_SIZE = 6;
export const PLAYGROUND_MAX_SIZE = 14;

export const playgroundMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

function swing(parts: THREE.BufferGeometry[], x: number, y: number): void {
  parts.push(propBox(x - 1.1, y - 0.5, 0, 0.08, 0.08, 2.2, METAL));
  parts.push(propBox(x + 1.1, y - 0.5, 0, 0.08, 0.08, 2.2, METAL));
  parts.push(propBox(x - 1.1, y + 0.5, 0, 0.08, 0.08, 2.2, METAL));
  parts.push(propBox(x + 1.1, y + 0.5, 0, 0.08, 0.08, 2.2, METAL));
  parts.push(propBox(x, y, 2.2, 2.3, 0.08, 0.08, METAL));
  for (const seatX of [-0.5, 0.5]) {
    parts.push(propBox(x + seatX, y, 1.5, 0.02, 0.02, 0.7, METAL));
    parts.push(propBox(x + seatX, y, 0.62, 0.5, 0.22, 0.06, SEAT));
  }
}

function slide(parts: THREE.BufferGeometry[], x: number, y: number): void {
  parts.push(propBox(x - 0.35, y - 0.8, 0, 0.06, 0.06, 1.6, METAL));
  parts.push(propBox(x + 0.35, y - 0.8, 0, 0.06, 0.06, 1.6, METAL));
  for (let i = 1; i <= 4; i++) {
    parts.push(propBox(x, y - 0.8, i * 0.3, 0.75, 0.05, 0.05, METAL));
  }
  parts.push(propBox(x, y - 0.45, 1.6, 0.9, 0.9, 0.08, SLIDE));
  // a sloped ramp down toward +y
  const ramp = new THREE.BoxGeometry(0.8, 2.2, 0.06);
  ramp.rotateX(-0.55);
  ramp.translate(x, y + 0.65, 0.85);
  parts.push(coloured(ramp, SLIDE));
}

function spring(parts: THREE.BufferGeometry[], x: number, y: number): void {
  parts.push(propCylinder(x, y, 0, 0.08, 0.1, 0.5, 6, METAL));
  parts.push(propBox(x, y, 0.5, 0.55, 0.3, 0.12, SPRING));
  parts.push(propBox(x, y - 0.18, 0.62, 0.5, 0.06, 0.3, SPRING));
}

function seesaw(parts: THREE.BufferGeometry[], x: number, y: number): void {
  parts.push(propBox(x, y, 0, 0.35, 0.35, 0.5, METAL));
  parts.push(propBox(x, y, 0.5, 2.4, 0.28, 0.08, SEAT));
  parts.push(propBox(x - 1.0, y, 0.58, 0.06, 0.06, 0.4, METAL));
  parts.push(propBox(x + 1.0, y, 0.58, 0.06, 0.06, 0.4, METAL));
}

function climbingFrame(
  parts: THREE.BufferGeometry[],
  x: number,
  y: number,
): void {
  for (const dx of [-0.8, 0.8]) {
    for (const dy of [-0.8, 0.8]) {
      parts.push(propBox(x + dx, y + dy, 0, 0.08, 0.08, 1.8, CLIMB));
    }
  }
  parts.push(propBox(x, y - 0.8, 1.8, 1.7, 0.08, 0.08, CLIMB));
  parts.push(propBox(x, y + 0.8, 1.8, 1.7, 0.08, 0.08, CLIMB));
  parts.push(propBox(x - 0.8, y, 1.8, 1.7, 0.08, 0.08, CLIMB));
  parts.push(propBox(x + 0.8, y, 1.8, 1.7, 0.08, 0.08, CLIMB));
}

/** The geometry for one playground point, or empty for an unusable feature. */
export function playground(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const geometry = f.geometry;
  if (geometry.type !== "Point") {
    throw Error(`Cannot have playground of type ${geometry.type}`);
  }
  const props = f.properties as { size?: unknown } | null;
  const requested = Number(props?.size);
  const size = Number.isFinite(requested)
    ? Math.min(PLAYGROUND_MAX_SIZE, Math.max(PLAYGROUND_MIN_SIZE, requested))
    : 10;
  const radius = size / 2;
  // a huge mapped playground should not become a blank sand field: cap the
  // patch and keep the equipment within it
  const patch = Math.min(radius, 7);
  const parts: THREE.BufferGeometry[] = [];

  const ground = new THREE.CircleGeometry(patch, 16);
  ground.translate(0, 0, 0.02);
  parts.push(coloured(ground, SAND));
  const border = new THREE.TorusGeometry(patch * 0.98, 0.07, 4, 24);
  border.translate(0, 0, 0.09);
  parts.push(coloured(border, BORDER));

  swing(parts, -patch * 0.28, -patch * 0.18);
  slide(parts, patch * 0.25, -patch * 0.2);
  spring(parts, 0, patch * 0.3);
  if (patch > 4.5) {
    climbingFrame(parts, patch * 0.25, patch * 0.25);
    seesaw(parts, 0, -patch * 0.5);
  }

  const merged = mergeParts(parts);
  if (!merged) return [];
  const [x, y] = toModelCoords(
    [geometry.coordinates[0], geometry.coordinates[1]],
    originMeters,
    scaleFactor,
  );
  return [placeAt(merged, x, y, quarterTurn(f.id))];
}
