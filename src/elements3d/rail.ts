import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { MeshBuilder } from "./mesh_builder";

/*
 * Rails and tram tracks: a ballast ribbon, two steel rails and sleepers for
 * heavy rail; two embedded rails for trams. Catenary poles and a wire run along
 * both. Clipped per tile by tilegen and merged into one Lambert mesh per tile
 * (kind `rail`). Tunnels, bridges and covered sections are skipped in tilegen;
 * the moving trains keep their own precomputed paths.
 */

const GAUGE = 1.435;
const BALLAST = new THREE.Color("#6f675b");
const STEEL = new THREE.Color("#5b5b58");
const SLEEPER = new THREE.Color("#5a4a3a");
const POLE = new THREE.Color("#555550");
const WIRE = new THREE.Color("#8a8a86");

export const railMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  // keep the thin rails and sleepers ahead of the ballast and the basemap
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});

type Point = [number, number];

interface Buffers {
  position: number[];
  normal: number[];
  uv: number[];
  color: number[];
}

function ribbon(
  buffers: Buffers,
  a: Point,
  b: Point,
  width: number,
  color: THREE.Color,
  z: number,
): void {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return;
  const rx = (-dy / length) * (width / 2);
  const ry = (dx / length) * (width / 2);
  const p = (x: number, y: number, u: number, v: number) => {
    buffers.position.push(x, y, z);
    buffers.normal.push(0, 0, 1);
    buffers.uv.push(u, v);
    buffers.color.push(color.r, color.g, color.b);
  };
  // the right-hand offset makes the naive order clockwise, so check the
  // signed area and reverse it when needed
  const ax = a[0] - rx;
  const ay = a[1] - ry;
  const bx = b[0] - rx;
  const by = b[1] - ry;
  const cx = b[0] + rx;
  const cy = b[1] + ry;
  const qx = a[0] + rx;
  const qy = a[1] + ry;
  const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (cross < 0) {
    p(ax, ay, 0, 0);
    p(cx, cy, 1, 1);
    p(bx, by, 1, 0);
    p(ax, ay, 0, 0);
    p(qx, qy, 0, 1);
    p(cx, cy, 1, 1);
  } else {
    p(ax, ay, 0, 0);
    p(bx, by, 1, 0);
    p(cx, cy, 1, 1);
    p(ax, ay, 0, 0);
    p(cx, cy, 1, 1);
    p(qx, qy, 0, 1);
  }
}

/** One rail/multi-rail line as a merged geometry. */
export function rail(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const geom = f.geometry;
  const lines =
    geom.type === "LineString"
      ? [geom.coordinates]
      : geom.type === "MultiLineString"
        ? geom.coordinates
        : [];
  const parts: THREE.BufferGeometry[] = [];
  const buffers: Buffers = { position: [], normal: [], uv: [], color: [] };
  const boxes = new MeshBuilder();
  const kind = f.properties?.kind === "tram" ? "tram" : "rail";
  const isRail = kind === "rail";

  for (const line of lines) {
    const points: Point[] = line.map(([lon, lat]) =>
      toModelCoords([lon, lat], originMeters, scaleFactor),
    );
    if (points.length < 2) continue;
    let travelled = 0;
    let nextPole = 8;
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length === 0) continue;
      const ux = dx / length;
      const uy = dy / length;
      const rx = uy;
      const ry = -ux;
      const at = (t: number, offset = 0): Point => [
        a[0] + ux * t + rx * offset,
        a[1] + uy * t + ry * offset,
      ];

      if (isRail) {
        ribbon(buffers, a, b, 3.4, BALLAST, 0.02);
        const sleeperEnd = length;
        for (let t = 0.45; t < sleeperEnd; t += 1.05) {
          const start = at(t - 0.11);
          const end = at(t + 0.11);
          ribbon(buffers, start, end, 2.6, SLEEPER, 0.065);
        }
      }
      const railZ = isRail ? 0.18 : 0.03;
      ribbon(
        buffers,
        at(0, GAUGE / 2),
        at(length, GAUGE / 2),
        0.08,
        STEEL,
        railZ,
      );
      ribbon(
        buffers,
        at(0, -GAUGE / 2),
        at(length, -GAUGE / 2),
        0.08,
        STEEL,
        railZ,
      );

      // catenary wire at the top, one per track
      ribbon(buffers, at(0), at(length), 0.045, WIRE, 5.9);

      while (nextPole <= travelled + length) {
        const t = nextPole - travelled;
        const [px, py] = at(t, 2.1);
        boxes.box(px, py, 0, 0.16, 0.16, 6.1, 0, POLE);
        boxes.box(px, py, 5.65, 2.5, 0.13, 0.13, Math.atan2(ry, rx), POLE);
        nextPole += 48;
      }
      travelled += length;
    }
  }

  if (buffers.position.length > 0) {
    const ribbons = new THREE.BufferGeometry();
    ribbons.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(buffers.position, 3),
    );
    ribbons.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(buffers.normal, 3),
    );
    ribbons.setAttribute("uv", new THREE.Float32BufferAttribute(buffers.uv, 2));
    ribbons.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(buffers.color, 3),
    );
    parts.push(ribbons);
  }
  const boxGeometry = boxes.geometry();
  if (boxGeometry) parts.push(boxGeometry);
  if (parts.length === 0) return [];
  const merged = BufferGeometryUtils.mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return merged ? [merged] : [];
}
