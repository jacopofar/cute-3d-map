import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { BoxBuilder } from "./box_builder";

/*
 * Foot and cycle paths inside parks and green areas. tilegen clips each OSM way
 * to the tile's green union, so a riverside path stops at the park boundary and
 * a path crossing a tile boundary is stored once per tile. Each segment becomes
 * a flat box; the walk default is light brown, the cycle default brick red, and
 * a mapped `surface` overrides both with a material-appropriate tone.
 */

const WALK_DEFAULT = "#c8a273";
const BIKE_DEFAULT = "#a85f4a";

const SURFACE_COLORS: Record<string, string> = {
  asphalt: "#4f5354",
  concrete: "#a9a69d",
  paving_stones: "#b9aa96",
  paving_stone: "#b9aa96",
  paved: "#aaa79e",
  sett: "#8e877b",
  cobblestone: "#8e877b",
  stepping_stones: "#9f9a90",
  chipseal: "#4c4f4f",
  "concrete:plates": "#a9a69d",
  "concrete:lanes": "#a9a69d",
  grass_paver: "#78945a",
  compacted: "#b58f63",
  fine_gravel: "#c0a37b",
  gravel: "#b69a73",
  unpaved: "#ad8a61",
  ground: "#8a6b4c",
  dirt: "#86613f",
  earth: "#7d5b3e",
  grass: "#6f8f4a",
  wood: "#99724c",
  woodchips: "#9b7b52",
  pebblestone: "#b6a07e",
  mud: "#6f5540",
  sand: "#d3bd8e",
  stone: "#98938a",
  unhewn_cobblestone: "#8b857a",
  metal: "#777d80",
  metal_grid: "#777d80",
};

const PATH_Z = 0.03;
const PATH_HEIGHT = 0.04;

export const parkPathMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

function kindOf(f: Geojson.Feature): "walk" | "bike" {
  return f.properties?.kind === "bike" ? "bike" : "walk";
}

export function parkPathColor(f: Geojson.Feature): THREE.Color {
  const surface = String(f.properties?.surface ?? "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  const named = SURFACE_COLORS[surface];
  if (named) return new THREE.Color(named);
  return new THREE.Color(kindOf(f) === "bike" ? BIKE_DEFAULT : WALK_DEFAULT);
}

function linesOf(f: Geojson.Feature): Geojson.Position[][] {
  if (f.geometry.type === "LineString") return [f.geometry.coordinates];
  if (f.geometry.type === "MultiLineString") return f.geometry.coordinates;
  return [];
}

export function parkPath(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const color = parkPathColor(f);
  const width = Math.min(
    8,
    Math.max(
      0.8,
      Number(f.properties?.width) || (kindOf(f) === "bike" ? 2.5 : 1.8),
    ),
  );
  const b = new BoxBuilder();
  for (const line of linesOf(f)) {
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
      const dx = bx - ax;
      const dy = by - ay;
      const length = Math.hypot(dx, dy);
      if (length < 0.1) continue;
      // overlap the segment ends by half a width so bends do not leave a notch
      b.box(
        (ax + bx) / 2,
        (ay + by) / 2,
        PATH_Z,
        length + width * 0.5,
        width,
        PATH_HEIGHT,
        Math.atan2(dy, dx),
        color,
      );
    }
  }
  const geometry = b.geometry();
  return geometry ? [geometry] : [];
}
