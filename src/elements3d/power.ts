import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { MeshBuilder } from "./mesh_builder";

/*
 * Overhead power lines and pylons. tilegen clips an OSM `power=line` to each
 * tile and emits the towers separately; the frontend turns a line vertex pair
 * into a sagging span. Towers are merged Lambert boxes per tile, wires are one
 * LineSegments per tile, and both share the power-lines checkbox.
 */

const STEEL = new THREE.Color("#4b5054");
const STEEL_DARK = new THREE.Color("#34393c");
const INSULATOR = new THREE.Color("#b9b2a1");

export const powerTowerMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

export const powerWireMaterial = new THREE.LineBasicMaterial({
  color: 0x30363a,
  transparent: true,
  opacity: 0.85,
});

function towerHeight(f: Geojson.Feature): number {
  const value = Number(f.properties?.height);
  return Number.isFinite(value) ? Math.min(70, Math.max(10, value)) : 30;
}

function addLeg(
  b: MeshBuilder,
  bx: number,
  by: number,
  tx: number,
  ty: number,
  bottom: number,
  top: number,
): void {
  // two stacked posts give the pylon its inward taper without a custom mesh
  const mid = (bottom + top) / 2;
  b.box(bx, by, bottom, 0.22, 0.22, mid - bottom, 0, STEEL);
  b.box(tx, ty, mid, 0.2, 0.2, top - mid, 0, STEEL);
}

export function powerTower(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  if (f.geometry.type !== "Point") return [];
  const [x, y] = toModelCoords(
    f.geometry.coordinates as [number, number],
    originMeters,
    scaleFactor,
  );
  const height = towerHeight(f);
  const b = new MeshBuilder();
  const half = Math.max(0.8, height * 0.055);
  for (const [dx, dy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    addLeg(
      b,
      x + dx * half,
      y + dy * half,
      x + dx * half * 0.55,
      y + dy * half * 0.55,
      0,
      height,
    );
  }
  b.box(x, y, 0, half * 2.2, half * 2.2, 0.6, 0, STEEL_DARK);
  // horizontal rungs read as a lattice at a distance; the boxes stay cheap
  for (const fraction of [0.2, 0.38, 0.56, 0.74]) {
    const z = height * fraction;
    const spread = half * 1.5 * (1 - fraction * 0.3);
    b.box(x, y, z, spread * 2, 0.09, 0.09, 0, STEEL);
    b.box(x, y, z, 0.09, spread * 2, 0.09, 0, STEEL);
  }
  const arm = Math.max(2.4, Math.min(7, height * 0.18));
  for (const [fraction, width] of [
    [0.7, arm],
    [0.88, arm * 0.78],
  ]) {
    b.box(x, y, height * fraction, width * 2, 0.18, 0.18, 0, STEEL_DARK);
    for (const side of [-1, 1]) {
      b.box(
        x + side * width,
        y,
        height * fraction - 0.3,
        0.22,
        0.22,
        0.42,
        0,
        INSULATOR,
      );
    }
  }
  b.box(x, y, height, 0.18, 0.18, 0.9, 0, STEEL_DARK);
  const geometry = b.geometry();
  return geometry ? [geometry] : [];
}

function lineParts(f: Geojson.Feature): Geojson.Position[][] {
  if (f.geometry.type === "LineString") return [f.geometry.coordinates];
  if (f.geometry.type === "MultiLineString") return f.geometry.coordinates;
  return [];
}

export function powerWire(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const height = Math.max(5, Number(f.properties?.height) || 20);
  const positions: number[] = [];
  for (const line of lineParts(f)) {
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = toModelCoords(
        line[i - 1] as [number, number],
        originMeters,
        scaleFactor,
      );
      const [bx, by] = toModelCoords(
        line[i] as [number, number],
        originMeters,
        scaleFactor,
      );
      const length = Math.hypot(bx - ax, by - ay);
      if (length < 1) continue;
      const sag = Math.min(5, length * 0.03);
      const steps = Math.max(3, Math.min(12, Math.round(length / 12)));
      let px = ax;
      let py = ay;
      let pz = height;
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const nx = ax + (bx - ax) * t;
        const ny = ay + (by - ay) * t;
        const nz = height - sag * 4 * t * (1 - t);
        positions.push(px, py, pz, nx, ny, nz);
        px = nx;
        py = ny;
        pz = nz;
      }
    }
  }
  if (positions.length === 0) return [];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  return [geometry];
}
