import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { MeshBuilder } from "./mesh_builder";

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
// how far back from the stop line the lane boundaries are painted solid, and how
// wide that paint is. This is the turn-lane pocket: the arrows sit inside it and
// the solid edges are what say "you are committed to this lane now".
const TURN_LANE_LENGTH = 22;
const LANE_LINE_WIDTH = 0.16;
const WHITE = new THREE.Color("#ffffff");
const OUTLINE_COLOR = new THREE.Color("#4c4c48");

export const roadMarkingMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

type Point = [number, number];

// the paint is flat, so the two helpers only differ in how many corners they
// take; the winding and the attribute set come from the shared builder
function quad(
  builder: MeshBuilder,
  a: Point,
  b: Point,
  c: Point,
  d: Point,
  color: THREE.Color,
  z: number,
): void {
  builder.quad(
    [a[0], a[1], z],
    [b[0], b[1], z],
    [c[0], c[1], z],
    [d[0], d[1], z],
    [0, 0, 1],
    color,
  );
}

function triangle(
  builder: MeshBuilder,
  a: Point,
  b: Point,
  c: Point,
  color: THREE.Color,
  z: number,
): void {
  builder.triangle(
    [a[0], a[1], z],
    [b[0], b[1], z],
    [c[0], c[1], z],
    [0, 0, 1],
    color,
  );
}

function stopLine(
  builder: MeshBuilder,
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
  quad(builder, a, b, c, d, color, z);
}

function arrow(
  builder: MeshBuilder,
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
    builder,
    at(-1.2, -0.13),
    at(0.25, -0.13),
    at(0.25, 0.13),
    at(-1.2, 0.13),
    color,
    z,
  );
  triangle(builder, at(0.25, -0.45), at(0.25, 0.45), at(1.25, 0), color, z);
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

  const builder = new MeshBuilder();

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
          builder,
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
          builder,
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
        builder,
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
        builder,
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

    // Turn-lane paint: the approach's lane boundaries go solid, from the stop
    // line back the length of the pocket. A through lane and a turning lane are
    // otherwise drawn identically on the road, so this plus the arrow is what
    // separates them.
    const separatorCenter = front(STOP_OFFSET + TURN_LANE_LENGTH / 2);
    for (let k = 1; k < approachLanes; k++) {
      const offset =
        (oneWay ? 0 : width / 4) + (k - approachLanes / 2) * laneWidth;
      stopLine(
        builder,
        separatorCenter,
        [fx, fy],
        [rx, ry],
        offset - LANE_LINE_WIDTH / 2 - OUTLINE,
        offset + LANE_LINE_WIDTH / 2 + OUTLINE,
        TURN_LANE_LENGTH + 2 * OUTLINE,
        OUTLINE_COLOR,
        OUTLINE_LIFT,
      );
      stopLine(
        builder,
        separatorCenter,
        [fx, fy],
        [rx, ry],
        offset - LANE_LINE_WIDTH / 2,
        offset + LANE_LINE_WIDTH / 2,
        TURN_LANE_LENGTH,
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
      arrow(builder, center, angle, 1.15, OUTLINE_COLOR, OUTLINE_LIFT);
      arrow(builder, center, angle, 1, WHITE, LIFT);
    }
  }

  const painted = builder.geometry();
  return painted ? [painted] : [];
}
