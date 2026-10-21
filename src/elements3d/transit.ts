import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../geojson_data";
import { BoxBuilder } from "./box_builder";
import { hashSeed } from "./random";

/*
 * Transit stops in the Milan look:
 * - a metro entrance gets a dark stair opening and an "M" totem: a white panel
 *   with the red M, crossed so it reads from every side (the sign is its own
 *   textured mesh, one per tile, because it cannot share the vertex-color
 *   material of the poles);
 * - a bus or tram stop gets the yellow palina: a pole and a yellow sign, plus a
 *   shelter (posts, roof, glass back and a bench) when OSM says it is covered.
 *
 * Everything else is merged into one Lambert mesh per tile. No shadows: these
 * are street props, like the benches and furniture.
 */

export type TransitStopKind = "metro" | "bus" | "tram";

const DARK = new THREE.Color("#2c3034");
const METAL = new THREE.Color("#6f757c");
const YELLOW = new THREE.Color("#e8a800");
const SIGN_DARK = new THREE.Color("#1e1f21");
const GLASS = new THREE.Color("#a9c7d6");
const ROOF = new THREE.Color("#3c4247");
const WOOD = new THREE.Color("#8a5a33");
const METRO_RED = new THREE.Color("#c62828");
const STAIR = new THREE.Color("#1a1d20");

export const transitStopMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

let signMaterial: THREE.MeshBasicMaterial | undefined;

/**
 * The white panel with the red M, shared by every metro sign. Built lazily
 * because it needs a canvas: unit tests build the sign geometry without ever
 * calling this.
 */
export function metroSignMaterial(): THREE.MeshBasicMaterial {
  if (signMaterial) return signMaterial;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 160;
  const context = canvas.getContext("2d");
  if (context) {
    // the Milan sign is a red panel with a white M
    context.fillStyle = "#c62828";
    context.fillRect(0, 0, 128, 160);
    context.fillStyle = "#ffffff";
    context.font = "bold 104px Arial, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("M", 64, 86);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  signMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.1,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  return signMaterial;
}

function isKind(value: unknown): value is TransitStopKind {
  return value === "metro" || value === "bus" || value === "tram";
}

export interface TransitStopGeometry {
  body: THREE.BufferGeometry[];
  sign: THREE.BufferGeometry[];
}

function busShelter(b: BoxBuilder): void {
  // four posts, a flat roof, a glass back and a bench inside
  for (const x of [-0.78, 0.78]) {
    for (const y of [-1.15, 1.15]) {
      b.box(x, y, 0, 0.08, 0.08, 2.3, 0, METAL);
    }
  }
  b.box(0, 0, 2.3, 1.9, 2.6, 0.12, 0, ROOF);
  b.box(0, 1.15, 0.2, 1.55, 0.06, 1.9, 0, GLASS);
  b.box(0, 0.75, 0.42, 1.3, 0.4, 0.1, 0, WOOD);
  b.box(-0.55, 0.75, 0.42, 0.08, 0.4, 0.42, 0, METAL);
  b.box(0.55, 0.75, 0.42, 0.08, 0.4, 0.42, 0, METAL);
}

function busStop(b: BoxBuilder, shelter: boolean): void {
  b.box(0, 0, 0, 0.08, 0.08, 2.7, 0, METAL);
  // the yellow palina, with a dark band at the top
  b.box(0, -0.05, 1.9, 0.62, 0.06, 0.9, 0, YELLOW);
  b.box(0, -0.1, 2.62, 0.62, 0.07, 0.16, 0, SIGN_DARK);
  if (shelter) busShelter(b);
}

function metroEntrance(b: BoxBuilder): void {
  // the stair opening and its low side walls; the totem stands beside it
  b.box(0, 0, 0, 1.8, 2.6, 0.16, 0, STAIR);
  b.box(-0.95, 0, 0.16, 0.12, 2.6, 0.5, 0, METAL);
  b.box(0.95, 0, 0.16, 0.12, 2.6, 0.5, 0, METAL);
  b.box(1.25, 0, 0, 0.62, 0.62, 0.22, 0, METRO_RED);
  b.box(1.25, 0, 0.22, 0.12, 0.12, 3.1, 0, DARK);
}

function metroSign(): THREE.BufferGeometry {
  const plane = new THREE.PlaneGeometry(1.3, 1.7);
  // one panel, not a cross: the material is double-sided, so the M reads from
  // both faces (and the letter is horizontally symmetric, so the back is not a
  // mirrored oddity)
  plane.rotateX(Math.PI / 2);
  // the totem pole is at x = 1.25; the panel starts just above head height
  plane.translate(1.25, 0, 2.55);
  return plane;
}

/**
 * The props for one stop: the vertex-colored body merged per tile, and (for a
 * metro entrance) the textured sign planes as a separate geometry.
 */
export function transitStop(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): TransitStopGeometry {
  const props = f.properties as {
    stop?: unknown;
    name?: unknown;
    shelter?: unknown;
  } | null;
  const kind = props?.stop;
  if (!isKind(kind)) {
    throw Error(`Unknown transit stop kind ${String(kind)}`);
  }
  const geometry = f.geometry;
  if (geometry.type !== "Point") {
    throw Error(`Cannot have transit stop of type ${geometry.type}`);
  }
  const [x, y] = toModelCoords(
    [geometry.coordinates[0], geometry.coordinates[1]],
    originMeters,
    scaleFactor,
  );
  const angle = (hashSeed(`${f.id}`) % 4) * (Math.PI / 2);

  const builder = new BoxBuilder();
  if (kind === "metro") metroEntrance(builder);
  else busStop(builder, props?.shelter === true);
  const body = builder.geometry();
  body?.rotateZ(angle);
  body?.translate(x, y, 0);

  const sign = kind === "metro" ? metroSign() : null;
  sign?.rotateZ(angle);
  sign?.translate(x, y, 0);

  return {
    body: body ? [body] : [],
    sign: sign ? [sign] : [],
  };
}
