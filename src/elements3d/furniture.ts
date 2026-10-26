import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { MeshBuilder } from "./mesh_builder";
import { placeAt, quarterTurn } from "./props";

/*
 * Street furniture: bollards, bins, bike racks, post boxes, drinking fountains,
 * info boards and hydrants. tilegen turns each OSM object into a point with a
 * `furniture` kind, so a whole tile merges into one mesh of simple boxes.
 *
 * The props are deliberately small and low-poly (a handful of boxes each) and
 * they do not cast shadows: the point is the silhouette and the density of a
 * real street, not a modelled bollard. The Lambert material lets them go dark
 * at night with the benches and buildings.
 */

export type FurnitureKind =
  | "bollard"
  | "bin"
  | "bike_rack"
  | "post_box"
  | "drinking_water"
  | "info_board"
  | "hydrant";

const IRON = new THREE.Color("#3f444b");
const IRON_TOP = new THREE.Color("#7b818a");
const BIN = new THREE.Color("#3f4a40");
const BIN_LID = new THREE.Color("#2a312b");
const METAL = new THREE.Color("#6a7179");
const POST = new THREE.Color("#d9a520");
const POST_DARK = new THREE.Color("#2b2b28");
const POST_BASE = new THREE.Color("#3a3a38");
const STONE = new THREE.Color("#9a978d");
const BRONZE = new THREE.Color("#7a6a4a");
const FRAME = new THREE.Color("#4a4f57");
const PANEL = new THREE.Color("#2e4d66");
const HYDRANT = new THREE.Color("#b23a32");
const HYDRANT_DARK = new THREE.Color("#7d2620");

export const furnitureMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

function isFurnitureKind(value: unknown): value is FurnitureKind {
  return (
    value === "bollard" ||
    value === "bin" ||
    value === "bike_rack" ||
    value === "post_box" ||
    value === "drinking_water" ||
    value === "info_board" ||
    value === "hydrant"
  );
}

/**
 * The angle the prop's local +x should take. tilegen writes a compass bearing
 * for a line-mapped prop (a bike rack along the kerb); the rest get a stable
 * quarter-turn from the feature id so a street does not look stamped.
 */
function propAngle(f: Geojson.Feature): number {
  const props = f.properties as { angle?: unknown } | null;
  const bearing = props ? Number(props.angle) : NaN;
  if (Number.isFinite(bearing)) {
    // local +x along the line: north (0) needs +90 degrees, east (90) none
    return Math.PI / 2 - (bearing * Math.PI) / 180;
  }
  return quarterTurn(f.id);
}

function build(kind: FurnitureKind): THREE.BufferGeometry | null {
  const b = new MeshBuilder();
  switch (kind) {
    case "bollard":
      b.box(0, 0, 0, 0.16, 0.16, 0.9, 0, IRON);
      b.box(0, 0, 0.9, 0.2, 0.2, 0.06, 0, IRON_TOP);
      break;
    case "bin":
      b.box(0, 0, 0, 0.46, 0.46, 0.82, 0, BIN);
      b.box(0, 0, 0.82, 0.52, 0.52, 0.08, 0, BIN_LID);
      break;
    case "bike_rack":
      b.box(-0.45, 0, 0, 0.08, 0.08, 0.82, 0, METAL);
      b.box(0.45, 0, 0, 0.08, 0.08, 0.82, 0, METAL);
      b.box(0, 0, 0.82, 0.98, 0.08, 0.08, 0, METAL);
      // a lower rail, so the U reads as a rack from the side too
      b.box(0, 0, 0.35, 0.98, 0.06, 0.06, 0, METAL);
      break;
    case "post_box":
      b.box(0, 0, 0, 0.62, 0.55, 0.12, 0, POST_BASE);
      b.box(0, 0, 0.12, 0.5, 0.45, 1.0, 0, POST);
      // the slot sits proud of the front face
      b.box(0, -0.235, 0.75, 0.34, 0.03, 0.09, 0, POST_DARK);
      break;
    case "drinking_water":
      b.box(0, 0, 0, 0.36, 0.36, 0.9, 0, STONE);
      b.box(0, -0.2, 0.8, 0.12, 0.22, 0.1, 0, BRONZE);
      b.box(0, 0, 0.9, 0.5, 0.5, 0.08, 0, STONE);
      break;
    case "info_board":
      b.box(-0.55, 0, 0, 0.08, 0.08, 2.0, 0, FRAME);
      b.box(0.55, 0, 0, 0.08, 0.08, 2.0, 0, FRAME);
      b.box(0, 0, 1.05, 1.38, 0.14, 0.98, 0, FRAME);
      b.box(0, -0.09, 1.1, 1.25, 0.04, 0.85, 0, PANEL);
      break;
    case "hydrant":
      b.box(0, 0, 0, 0.26, 0.26, 0.62, 0, HYDRANT);
      b.box(0, 0, 0.62, 0.36, 0.36, 0.12, 0, HYDRANT_DARK);
      b.box(0, 0, 0.35, 0.5, 0.14, 0.14, 0, HYDRANT);
      break;
  }
  return b.geometry();
}

/** The geometry for one street-furniture point; empty when the kind is unknown. */
export function furniture(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const props = f.properties as { furniture?: unknown } | null;
  const kind = props?.furniture;
  if (!isFurnitureKind(kind)) return [];
  const geometry = f.geometry;
  if (geometry.type !== "Point") {
    throw Error(`Cannot have furniture of type ${geometry.type}`);
  }
  const [x, y] = toModelCoords(
    [geometry.coordinates[0], geometry.coordinates[1]],
    originMeters,
    scaleFactor,
  );
  const built = build(kind);
  if (!built) return [];
  // rotate the whole prop around the feature point, not each box around its own
  return [placeAt(built, x, y, propAngle(f))];
}
