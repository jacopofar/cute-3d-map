import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../geojson_data";
import { BoxBuilder } from "./box_builder";
import { hashSeed } from "./random";
import { tombstoneSpots } from "./tombstone_rows";

/*
 * Cemeteries: rows of simple tombstones over the basemap.
 *
 * tilegen clips the `landuse=cemetery` area to the tile and emits it as its own
 * kind. OSM rarely maps the individual graves, so the rows are procedural
 * (tombstone_rows.ts): aligned to the longest wall, inset from the boundary and
 * capped so a large cemetery does not turn one tile into a million triangles.
 *
 * The cemetery polygon is only the layout region: there is no 3D ground on
 * purpose, so the basemap's cemetery paths and lawns remain visible under the
 * rows. The stones are one merged geometry per feature, one Lambert material
 * per tile, and do not cast shadows.
 */

type Point = [number, number];

// mid-gray stone: the basemap cemetery is a pale beige, so white marble would
// disappear into it; a few pale stones keep the rows from looking uniform
const STONE_COLORS = [
  "#8d877a",
  "#a39d8f",
  "#777165",
  "#b9b3a4",
  "#6b665c",
  "#c9c4b6",
];
const CROSS_COLOR = new THREE.Color("#ded8c8");

export const MAX_TOMBSTONES_PER_TILE = 9000;

// a small cap per slab/cross, in triangles: the point is the silhouette, not a
// modelled headstone, because there can be thousands of them
const SLAB_WIDTH = 1.1;
const SLAB_DEPTH = 0.32;
const SLAB_HEIGHT = 1.35;

export const cemeteryMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

function hashPoint(point: Point): number {
  return hashSeed(`${point[0].toFixed(6)},${point[1].toFixed(6)}`);
}

function polygonOf(
  geometry: Geojson.Polygon | Geojson.MultiPolygon,
): Geojson.Position[][][] {
  return geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.coordinates;
}

/**
 * The cemetery geometries for one feature: a clipped polygon part per ground
 * piece, with its tombstones. Empty when the feature has no usable area.
 */
export function cemetery(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const geometry = f.geometry;
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
    throw Error(`Cannot have cemetery of type ${geometry.type}`);
  }
  const seed = hashSeed(`${f.id}`);
  const out: THREE.BufferGeometry[] = [];
  let budget = MAX_TOMBSTONES_PER_TILE;
  for (const polygon of polygonOf(geometry)) {
    const rings: Point[][] = polygon.map((ring) =>
      ring.map(([lon, lat]) =>
        toModelCoords([lon, lat], originMeters, scaleFactor),
      ),
    );
    if (rings.length === 0 || rings[0].length < 3) continue;
    const rng = (seed + hashPoint(rings[0][0])) >>> 0;
    const builder = new BoxBuilder();

    const spots =
      budget > 0
        ? tombstoneSpots(rings, {
            seed: rng,
            maxStones: budget,
          })
        : [];
    for (const spot of spots) {
      const stone = new THREE.Color(
        STONE_COLORS[spot.kind % STONE_COLORS.length],
      );
      if (spot.kind === 0) {
        // a cross: a slim upright and a shorter bar, on a low plinth
        builder.box(spot.x, spot.y, 0.03, 0.78, 0.32, 0.18, spot.angle, stone);
        builder.box(
          spot.x,
          spot.y,
          0.19,
          0.16,
          0.16,
          1.15,
          spot.angle,
          CROSS_COLOR,
        );
        builder.box(
          spot.x,
          spot.y,
          0.78,
          0.62,
          0.16,
          0.14,
          spot.angle,
          CROSS_COLOR,
        );
      } else {
        const height = SLAB_HEIGHT + ((spot.kind % 5) - 2) * 0.04;
        builder.box(
          spot.x,
          spot.y,
          0.03,
          SLAB_WIDTH,
          SLAB_DEPTH,
          height,
          spot.angle,
          stone,
        );
      }
    }
    budget -= spots.length;
    const built = builder.geometry();
    if (built) out.push(built);
  }
  return out;
}
