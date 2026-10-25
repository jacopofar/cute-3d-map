import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";

/*
 * Stop lines and lane arrows at stop, give-way and signal nodes. tilegen
 * matches the node to its road way and carries the approach bearings, road
 * width and lane/turn tags; the frontend only lays the markings.
 *
 * One merged mesh per tile (kind `road_marking`), lit white paint with a thin
 * dark edge so it reads on the pale basemap. No shadows, no toggle, no popup:
 * these are street surface markings rather than props.
 */

const LIFT = 0.048;
const OUTLINE_LIFT = 0.041;
const OUTLINE = 0.06;
const STOP_OFFSET = 3.2;
const ARROW_OFFSET = 7.5;
const WHITE = new THREE.Color("#ffffff");
const OUTLINE_COLOR = new THREE.Color("#4c4c48");

export const roadMarkingMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

type Point = [number, number];

interface Buffers {
  position: number[];
  normal: number[];
  uv: number[];
  color: number[];
}

function quad(
  buffers: Buffers,
  a: Point,
  b: Point,
  c: Point,
  d: Point,
  color: THREE.Color,
  z: number,
): void {
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const [b2, d2] = cross < 0 ? [d, b] : [b, d];
  const vertex = (p: Point, u: number, v: number) => {
    buffers.position.push(p[0], p[1], z);
    buffers.normal.push(0, 0, 1);
    buffers.uv.push(u, v);
    buffers.color.push(color.r, color.g, color.b);
  };
  vertex(a, 0, 0);
  vertex(b2, 1, 0);
  vertex(c, 1, 1);
  vertex(a, 0, 0);
  vertex(c, 1, 1);
  vertex(d2, 0, 1);
}

function triangle(
  buffers: Buffers,
  a: Point,
  b: Point,
  c: Point,
  color: THREE.Color,
  z: number,
): void {
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const [p1, p2] = cross < 0 ? [c, b] : [b, c];
  const vertex = (p: Point) => {
    buffers.position.push(p[0], p[1], z);
    buffers.normal.push(0, 0, 1);
    buffers.uv.push(0, 0);
    buffers.color.push(color.r, color.g, color.b);
  };
  vertex(a);
  vertex(p1);
  vertex(p2);
}

function stopLine(
  buffers: Buffers,
  center: Point,
  forward: Point,
  right: Point,
  start: number,
  end: number,
  thickness: number,
  color: THREE.Color,
  z: number,
): void {
  const a: Point = [
    center[0] + right[0] * start - forward[0] * (thickness / 2),
    center[1] + right[1] * start - forward[1] * (thickness / 2),
  ];
  const b: Point = [
    center[0] + right[0] * end - forward[0] * (thickness / 2),
    center[1] + right[1] * end - forward[1] * (thickness / 2),
  ];
  const c: Point = [
    center[0] + right[0] * end + forward[0] * (thickness / 2),
    center[1] + right[1] * end + forward[1] * (thickness / 2),
  ];
  const d: Point = [
    center[0] + right[0] * start + forward[0] * (thickness / 2),
    center[1] + right[1] * start + forward[1] * (thickness / 2),
  ];
  quad(buffers, a, b, c, d, color, z);
}

function arrow(
  buffers: Buffers,
  center: Point,
  bearing: number,
  scale: number,
  color: THREE.Color,
  z: number,
): void {
  const radians = (bearing * Math.PI) / 180;
  const fx = Math.sin(radians);
  const fy = Math.cos(radians);
  const rx = Math.cos(radians);
  const ry = -Math.sin(radians);
  const at = (forward: number, right: number): Point => [
    center[0] + fx * forward * scale + rx * right * scale,
    center[1] + fy * forward * scale + ry * right * scale,
  ];
  quad(
    buffers,
    at(-1.2, -0.13),
    at(0.25, -0.13),
    at(0.25, 0.13),
    at(-1.2, 0.13),
    color,
    z,
  );
  triangle(buffers, at(0.25, -0.45), at(0.25, 0.45), at(1.25, 0), color, z);
}

function turnAngle(turn: string): number {
  const value = turn.trim().toLowerCase();
  if (value.includes("sharp_left")) return -65;
  if (value.includes("slight_left")) return -22;
  if (value.includes("left")) return -45;
  if (value.includes("sharp_right")) return 65;
  if (value.includes("slight_right")) return 22;
  if (value.includes("right")) return 45;
  if (value.includes("merge_to_left")) return -18;
  if (value.includes("merge_to_right")) return 18;
  return 0;
}

function turnFor(
  turns: string | undefined,
  lane: number,
  fallback: string,
): string {
  if (!turns) return fallback;
  const parts = turns.split("|");
  const value = parts[lane]?.trim();
  return value ? value.split(";")[0].trim() : fallback;
}

/** The stop line and lane arrows for one node, as a flat marking geometry. */
export function roadMarking(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const geometry = f.geometry;
  if (geometry.type !== "Point") return [];
  const props = f.properties ?? {};
  const directions = Array.isArray(props.directions)
    ? props.directions.map(Number).filter(Number.isFinite)
    : [];
  if (directions.length === 0) return [];

  const [x, y] = toModelCoords(
    geometry.coordinates as [number, number],
    originMeters,
    scaleFactor,
  );
  const width = Math.min(Math.max(Number(props.width) || 7, 3.5), 20);
  const lanes = Math.min(Math.max(Number(props.lanes) || 1, 1), 8);
  const oneway = props.oneway;
  const oneWay = oneway === "yes" || oneway === "true" || oneway === "-1";
  const approachLanes = oneWay ? lanes : Math.max(1, Math.round(lanes / 2));
  const half = width / 2;
  const laneWidth = (oneWay ? width : width / 2) / approachLanes;
  const lineStart = oneWay ? -half : 0;
  const lineEnd = half;
  const kind = props.kind;
  const giveWay = kind === "give_way";

  const buffers: Buffers = {
    position: [],
    normal: [],
    uv: [],
    color: [],
  };

  for (let d = 0; d < directions.length; d++) {
    const bearing = directions[d];
    const radians = (bearing * Math.PI) / 180;
    const fx = Math.sin(radians);
    const fy = Math.cos(radians);
    const rx = Math.cos(radians);
    const ry = -Math.sin(radians);
    const front = (distance: number): Point => [
      x - fx * distance,
      y - fy * distance,
    ];
    const stopCenter = front(STOP_OFFSET);

    // Stop or give-way line. A give-way line is broken; a stop line is solid.
    if (giveWay) {
      const segment = 0.9;
      const gap = 0.55;
      let start = lineStart;
      while (start < lineEnd) {
        const end = Math.min(start + segment, lineEnd);
        stopLine(
          buffers,
          stopCenter,
          [fx, fy],
          [rx, ry],
          start + OUTLINE,
          end - OUTLINE,
          0.3,
          OUTLINE_COLOR,
          OUTLINE_LIFT,
        );
        stopLine(
          buffers,
          stopCenter,
          [fx, fy],
          [rx, ry],
          start,
          end,
          0.3,
          WHITE,
          LIFT,
        );
        start += segment + gap;
      }
    } else {
      stopLine(
        buffers,
        stopCenter,
        [fx, fy],
        [rx, ry],
        lineStart - OUTLINE,
        lineEnd + OUTLINE,
        0.5 + 2 * OUTLINE,
        OUTLINE_COLOR,
        OUTLINE_LIFT,
      );
      stopLine(
        buffers,
        stopCenter,
        [fx, fy],
        [rx, ry],
        lineStart,
        lineEnd,
        0.5,
        WHITE,
        LIFT,
      );
    }

    // Lane arrows only where there is more than one lane for this approach;
    // a single-lane stop sign does not need a painted arrow.
    if (approachLanes < 2) continue;
    const turns =
      d === 0
        ? props.turn_lanes
        : (props.turn_lanes_backward ?? props.turn_lanes);
    const arrowCenter = front(ARROW_OFFSET);
    for (let lane = 0; lane < approachLanes; lane++) {
      const rightOffset =
        (oneWay ? 0 : width / 4) + (lane - (approachLanes - 1) / 2) * laneWidth;
      const center: Point = [
        arrowCenter[0] + rx * rightOffset,
        arrowCenter[1] + ry * rightOffset,
      ];
      const turn = turnFor(turns, lane, "through");
      const angle = bearing + turnAngle(turn);
      arrow(buffers, center, angle, 1.15, OUTLINE_COLOR, OUTLINE_LIFT);
      arrow(buffers, center, angle, 1, WHITE, LIFT);
    }
  }

  if (buffers.position.length === 0) return [];
  const out = new THREE.BufferGeometry();
  out.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(buffers.position, 3),
  );
  out.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(buffers.normal, 3),
  );
  out.setAttribute("uv", new THREE.Float32BufferAttribute(buffers.uv, 2));
  out.setAttribute("color", new THREE.Float32BufferAttribute(buffers.color, 3));
  return [out];
}
