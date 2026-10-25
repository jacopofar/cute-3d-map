import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { applyVertexColor } from "./vertex_color";
import { hashSeed } from "./random";

/*
 * Monuments and memorials: a stone plinth with a statue, an obelisk, a stele,
 * a plaque or the small brass square of a Stolperstein, chosen from the OSM
 * `historic`/`memorial` tags. All the pieces are simple primitives merged into
 * one Lambert mesh per tile; the point stays clickable for the OSM popup.
 *
 * No shadows: these are small, and the layer can have a few hundred plaques in
 * a dense centre.
 */

const STONE = new THREE.Color("#b9b4a6");
const STONE_DARK = new THREE.Color("#8c877b");
const WHITE = new THREE.Color("#e8e4da");
const BRASS = new THREE.Color("#c9a646");
const BRONZE = new THREE.Color("#7a5c35");

export const monumentMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

function coloured(
  geometry: THREE.BufferGeometry,
  color: THREE.Color,
): THREE.BufferGeometry {
  applyVertexColor(geometry, color);
  return geometry;
}

function box(
  x: number,
  y: number,
  baseZ: number,
  width: number,
  depth: number,
  height: number,
  color: THREE.Color,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, depth, height);
  geometry.translate(x, y, baseZ + height / 2);
  return coloured(geometry, color);
}

function cylinder(
  x: number,
  y: number,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  baseZ: number,
  segments: number,
  color: THREE.Color,
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(
    radiusTop,
    radiusBottom,
    height,
    segments,
  );
  geometry.rotateX(Math.PI / 2);
  geometry.translate(x, y, baseZ + height / 2);
  return coloured(geometry, color);
}

function sphere(
  x: number,
  y: number,
  z: number,
  radius: number,
  color: THREE.Color,
): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, 8, 6);
  geometry.translate(x, y, z);
  return coloured(geometry, color);
}

function statue(parts: THREE.BufferGeometry[], x: number, y: number): void {
  parts.push(box(x, y, 0, 1.5, 1.5, 0.9, STONE_DARK));
  parts.push(box(x, y, 0.9, 0.9, 0.9, 1.1, STONE));
  parts.push(cylinder(x, y, 0.24, 0.4, 1.9, 2.0, 8, STONE));
  parts.push(sphere(x, y, 4.0, 0.28, STONE));
}

function bust(parts: THREE.BufferGeometry[], x: number, y: number): void {
  parts.push(box(x, y, 0, 1.1, 1.1, 1.1, STONE_DARK));
  parts.push(box(x, y, 1.1, 0.8, 0.5, 0.55, STONE));
  parts.push(sphere(x, y, 1.9, 0.3, STONE));
}

function obelisk(parts: THREE.BufferGeometry[], x: number, y: number): void {
  parts.push(box(x, y, 0, 1.3, 1.3, 0.55, STONE_DARK));
  const shaft = new THREE.CylinderGeometry(0.18, 0.45, 3.8, 4);
  shaft.rotateY(Math.PI / 4);
  shaft.rotateX(Math.PI / 2);
  shaft.translate(x, y, 0.55 + 1.9);
  parts.push(coloured(shaft, STONE));
  const tip = new THREE.ConeGeometry(0.19, 0.45, 4);
  tip.rotateY(Math.PI / 4);
  tip.rotateX(Math.PI / 2);
  tip.translate(x, y, 4.8);
  parts.push(coloured(tip, STONE));
}

function warMemorial(
  parts: THREE.BufferGeometry[],
  x: number,
  y: number,
): void {
  parts.push(box(x, y, 0, 3.2, 1.3, 0.5, STONE_DARK));
  parts.push(box(x, y, 0.5, 1.5, 0.55, 2.2, STONE));
  parts.push(box(x, y, 2.55, 0.45, 0.45, 0.25, BRASS));
}

function plaque(parts: THREE.BufferGeometry[], x: number, y: number): void {
  parts.push(box(x, y, 0, 0.55, 0.55, 0.2, STONE_DARK));
  parts.push(box(x, y, 0.2, 0.12, 0.12, 0.9, STONE));
  parts.push(box(x, y, 1.05, 0.75, 0.08, 0.55, BRONZE));
}

function stolperstein(
  parts: THREE.BufferGeometry[],
  x: number,
  y: number,
): void {
  parts.push(box(x, y, 0.01, 0.2, 0.2, 0.03, BRASS));
}

function stone(parts: THREE.BufferGeometry[], x: number, y: number): void {
  parts.push(box(x, y, 0, 1.2, 0.9, 0.35, STONE_DARK));
  parts.push(box(x, y, 0.35, 0.8, 0.4, 1.9, STONE));
}

function ghostBike(parts: THREE.BufferGeometry[], x: number, y: number): void {
  parts.push(box(x, y, 0, 0.55, 0.35, 0.15, WHITE));
  parts.push(box(x - 0.45, y, 0.15, 0.06, 0.06, 0.8, WHITE));
  parts.push(box(x + 0.45, y, 0.15, 0.06, 0.06, 0.8, WHITE));
  parts.push(box(x, y, 0.9, 0.95, 0.06, 0.06, WHITE));
}

function build(
  kind: string,
  memorial: string | undefined,
): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  if (kind === "obelisk" || memorial === "obelisk") {
    obelisk(parts, 0, 0);
  } else if (memorial === "war_memorial") {
    warMemorial(parts, 0, 0);
  } else if (memorial === "statue" || memorial === "sculpture") {
    statue(parts, 0, 0);
  } else if (memorial === "bust") {
    bust(parts, 0, 0);
  } else if (memorial === "plaque" || memorial === "stolperstein") {
    if (memorial === "stolperstein") stolperstein(parts, 0, 0);
    else plaque(parts, 0, 0);
  } else if (memorial === "stone" || memorial === "stele") {
    stone(parts, 0, 0);
  } else if (memorial === "ghost_bike") {
    ghostBike(parts, 0, 0);
  } else if (kind === "monument") {
    statue(parts, 0, 0);
  } else {
    stone(parts, 0, 0);
  }
  return parts;
}

/** The geometry for one monument point, or empty for an unusable feature. */
export function monument(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const geometry = f.geometry;
  if (geometry.type !== "Point") {
    throw Error(`Cannot have monument of type ${geometry.type}`);
  }
  const props = f.properties as {
    kind?: unknown;
    memorial?: unknown;
  } | null;
  const kind = typeof props?.kind === "string" ? props.kind : "memorial";
  const memorial =
    typeof props?.memorial === "string" ? props.memorial : undefined;
  const parts = build(kind, memorial);
  const merged = BufferGeometryUtils.mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (!merged) return [];
  const [x, y] = toModelCoords(
    [geometry.coordinates[0], geometry.coordinates[1]],
    originMeters,
    scaleFactor,
  );
  merged.rotateZ((hashSeed(`${f.id}`) % 4) * (Math.PI / 2));
  merged.translate(x, y, 0);
  return [merged];
}
