import * as THREE from "three";

import { toModelCoords } from "../geojson_data";
import { parseColor } from "./color";
import {
  frameToWorld,
  roofKind,
  roofOutline,
  roofPlan,
  type PreparedRoof,
} from "./roof_layout";

// the last resort when a building carries no usable roof:colour (tilegen
// imputes one, so this is rare)
export const DEFAULT_ROOF_COLOR = "#8a7a66";

const DEGENERATE = 1e-9;

// Append a face as triangles, taking the normal from the winding (Newell's
// method) so it always agrees with the triangle order and is never culled.
function pushFace(
  positions: number[],
  normals: number[],
  uvs: number[],
  colors: number[],
  corners: [number, number, number][],
  rgb: THREE.Color,
): void {
  const n: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < corners.length; i++) {
    const p = corners[i];
    const q = corners[(i + 1) % corners.length];
    n[0] += (p[1] - q[1]) * (p[2] + q[2]);
    n[1] += (p[2] - q[2]) * (p[0] + q[0]);
    n[2] += (p[0] - q[0]) * (p[1] + q[1]);
  }
  const length = Math.hypot(n[0], n[1], n[2]);
  if (length < DEGENERATE) return;
  n[0] /= length;
  n[1] /= length;
  n[2] /= length;
  const triangles =
    corners.length === 4
      ? [
          [0, 1, 2],
          [0, 2, 3],
        ]
      : [[0, 1, 2]];
  for (const triangle of triangles) {
    for (const i of triangle) {
      positions.push(corners[i][0], corners[i][1], corners[i][2]);
      normals.push(n[0], n[1], n[2]);
      uvs.push(0, 0);
      colors.push(rgb.r, rgb.g, rgb.b);
    }
  }
}

// the ridge point a footprint vertex connects to: same footprint vertex pushed
// out to the ridge line at ridge height
function ridgePoint(
  roof: PreparedRoof,
  point: [number, number],
  height: number,
): [number, number, number] {
  const { frame, ridgeMin, ridgeMax } = roof;
  const along = point[0] * frame.axis[0] + point[1] * frame.axis[1];
  const clamped = Math.min(ridgeMax, Math.max(ridgeMin, along));
  const [x, y] = frameToWorld(frame, clamped, frame.acrossCentre);
  return [x, y, height + roof.rise];
}

/**
 * The roof over one footprint (lon/lat outer ring), as a geometry with the same
 * position/normal/uv/color attributes as the extruded walls, so it can be
 * merged into the building mesh. Returns null for a flat roof (the extrusion's
 * own top cap already is one).
 */
export function roofGeometry(
  rings: [number, number][][],
  height: number,
  originMeters: [number, number],
  scaleFactor: number,
  shape: string | undefined,
  roofColor: string | undefined,
  // a steeper-than-default roof, for a caller that wants one (a church)
  pitch = 1,
): THREE.BufferGeometry | null {
  // a courtyard (any inner ring) would be covered by a roof built over the outer
  // ring alone, so those stay flat
  if (rings.length !== 1) return null;
  const outline = roofOutline(
    rings[0].map((c) => toModelCoords([c[0], c[1]], originMeters, scaleFactor)),
  );
  if (!outline || outline.length < 3) return null;
  const points = outline;
  const roof = roofPlan(points, roofKind(shape), pitch);
  if (!roof) return null;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const rgb = parseColor(roofColor, DEFAULT_ROOF_COLOR);

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ra = ridgePoint(roof, a, height);
    const rb = ridgePoint(roof, b, height);
    const eaveA: [number, number, number] = [a[0], a[1], height];
    const eaveB: [number, number, number] = [b[0], b[1], height];
    const sameRidge =
      Math.abs(ra[0] - rb[0]) < 1e-6 &&
      Math.abs(ra[1] - rb[1]) < 1e-6 &&
      Math.abs(ra[2] - rb[2]) < 1e-6;
    pushFace(
      positions,
      normals,
      uvs,
      colors,
      sameRidge ? [eaveA, eaveB, ra] : [eaveA, eaveB, rb, ra],
      rgb,
    );
  }

  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}
