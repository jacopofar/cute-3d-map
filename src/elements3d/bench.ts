import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";

import { toModelCoords } from "../geojson_data";
import { applyVertexColor } from "./vertex_color";
import { hashSeed, makeRng } from "./random";

/*
 * A wooden street/park bench. Small and always loaded (a bench is a dozen
 * boxes, nothing next to a tree's canopy), so it only needs its own visibility
 * switch rather than the zoom gate the facade detail uses.
 *
 * Local space: X across the bench, Y the facing direction (the way the sitter
 * looks), Z up; the whole thing is built around the feature point, then turned
 * to the OSM `direction`.
 */

const WIDTH = 1.6;
const DEPTH = 0.5;
// seat plane height and the backrest top; roughly a real park bench
const SEAT_HEIGHT = 0.45;
const SEAT_THICKNESS = 0.05;
const BACK_HEIGHT = 0.4;
const BACK_THICKNESS = 0.05;
const LEG_SIZE = 0.06;
// how far the legs sit in from the seat's corners, so they read as a frame
const LEG_INSET = 0.1;

// warm mid brown: the vertex color is multiplied by the lighting and ACES tone
// mapping, so a darker wood ends up near black
const WOOD = new THREE.Color("#a9703c");
const METAL = new THREE.Color("#3b3f45");

/**
 * The direction the bench faces, in radians. OSM's `direction` tag is already
 * what the sitter looks at; when it is missing, a seeded facing from the id
 * keeps a bench stable across reloads and origin resets (a random one would
 * jitter on every rebuild).
 */
export function benchFacing(f: Geojson.Feature): number {
  const props = f.properties as { direction?: unknown } | null;
  const direction = props ? Number(props.direction) : NaN;
  if (Number.isFinite(direction)) {
    return (direction * Math.PI) / 180;
  }
  return makeRng(hashSeed(`${f.id}`))() * Math.PI * 2;
}

export function bench(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const geometry = f.geometry;
  let coord: [number, number];
  if (geometry.type === "Point") {
    coord = [geometry.coordinates[0], geometry.coordinates[1]];
  } else if (geometry.type === "LineString") {
    // tilegen collapses a way bench to its midpoint; kept here so an older
    // tile with the raw line still draws
    const line = geometry.coordinates;
    const mid = line[Math.floor((line.length - 1) / 2)];
    coord = [mid[0], mid[1]];
  } else {
    throw Error(`Cannot have bench of type ${geometry.type}`);
  }

  const pos = toModelCoords(coord, originMeters, scaleFactor);
  // a bench with no direction keeps its facing from the data; rotate the whole
  // local build around Z, then move it onto the feature point
  const facing = benchFacing(f);

  const parts: THREE.BufferGeometry[] = [];
  const place = (part: THREE.BufferGeometry, color: THREE.Color) => {
    applyVertexColor(part, color);
    part.rotateZ(-facing);
    part.translate(pos[0], pos[1], 0);
    parts.push(part);
  };

  const seat = new THREE.BoxGeometry(WIDTH, DEPTH, SEAT_THICKNESS);
  seat.translate(0, 0, SEAT_HEIGHT);
  place(seat, WOOD);

  // the backrest sits on the far side from the facing direction (local -Y)
  const back = new THREE.BoxGeometry(WIDTH, BACK_THICKNESS, BACK_HEIGHT);
  back.translate(
    0,
    -DEPTH / 2 + BACK_THICKNESS / 2,
    SEAT_HEIGHT + BACK_HEIGHT / 2,
  );
  place(back, WOOD);

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const leg = new THREE.BoxGeometry(LEG_SIZE, LEG_SIZE, SEAT_HEIGHT);
      leg.translate(
        sx * (WIDTH / 2 - LEG_INSET),
        sy * (DEPTH / 2 - LEG_INSET),
        SEAT_HEIGHT / 2,
      );
      place(leg, METAL);
    }
  }

  // one merged geometry per bench, looking like the tree: an unmergeable set
  // would drop the whole tile, so all parts share position/normal/uv/color
  const merged = BufferGeometryUtils.mergeGeometries(parts);
  return merged ? [merged] : parts;
}
