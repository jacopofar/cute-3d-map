import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";

/*
 * Flat, triangulated polygons. Ten modules had their own copy of
 * "rings → THREE.Shape (+ holes) → ShapeGeometry → toNonIndexed", and each copy
 * re-stated the same fragile invariant by hand: every geometry of a kind is
 * merged into one mesh per tile, so they must all carry the same attribute set
 * or `mergeGeometries` returns null and the whole kind disappears for that
 * tile. That invariant belongs in the helper's signature, not in ten comments.
 */

/** Model-space rings: the outline first, then any holes. */
export type Rings = [number, number][][];

export interface FlatPolygonOptions {
  /** how high the surface sits above the ground plane */
  z?: number;
  /**
   * Keep the flat `normal`. Off by default: the shader materials shade
   * themselves, and an unused attribute is dead weight in every vertex buffer.
   * Turn it on for a kind that a lit material draws.
   */
  keepNormal?: boolean;
  /** Keep the generated `uv`. Off by default, same reason as `keepNormal`. */
  keepUv?: boolean;
}

/** GeoJSON rings projected to model space, scaled by cos(latitude). */
export function projectRings(
  rings: Geojson.Position[][],
  originMeters: [number, number],
  scaleFactor: number,
): Rings {
  return rings.map((ring) =>
    ring.map((position) =>
      toModelCoords([position[0], position[1]], originMeters, scaleFactor),
    ),
  );
}

/**
 * The de-indexed copy of a geometry, with the indexed source disposed: every
 * geometry a kind carries is merged into loose triangles, and an indexed one
 * would make `mergeGeometries` fail on the mismatched set.
 */
export function unindexed(
  geometry: THREE.BufferGeometry,
): THREE.BufferGeometry {
  if (!geometry.index) return geometry;
  const flat = geometry.toNonIndexed();
  geometry.dispose();
  return flat;
}

/** The outline and holes as a `THREE.Shape`, for extruding or lofting. */
export function shapeFromRings(rings: Rings): THREE.Shape {
  const toVec = ([x, y]: [number, number]) => new THREE.Vector2(x, y);
  const shape = new THREE.Shape(rings[0].map(toVec));
  for (let h = 1; h < rings.length; h++) {
    shape.holes.push(new THREE.Path(rings[h].map(toVec)));
  }
  return shape;
}

/**
 * The outline and holes as a flat surface. Null when the rings triangulate to
 * nothing (a sliver, or a polygon that is entirely a hole), which every caller
 * has to handle: an empty geometry would break the tile's merge.
 */
export function flatShapePolygon(
  rings: Rings,
  options: FlatPolygonOptions = {},
): THREE.BufferGeometry | null {
  if (rings.length === 0 || rings[0].length < 3) return null;
  const shape = new THREE.ShapeGeometry(shapeFromRings(rings));
  const geometry = shape.index ? shape.toNonIndexed() : shape;
  // `toNonIndexed` copies, and the source is only a building block
  if (geometry !== shape) shape.dispose();
  if (!options.keepNormal) geometry.deleteAttribute("normal");
  if (!options.keepUv) geometry.deleteAttribute("uv");
  if (options.z) geometry.translate(0, 0, options.z);
  return geometry.getAttribute("position").count >= 3 ? geometry : null;
}

/**
 * The same, from GeoJSON rings in lon/lat: projected to model space and scaled
 * by cos(latitude), which is what anchors the polygon to the map.
 */
export function flatPolygon(
  rings: Geojson.Position[][],
  originMeters: [number, number],
  scaleFactor: number,
  options: FlatPolygonOptions = {},
): THREE.BufferGeometry | null {
  return flatShapePolygon(
    projectRings(rings, originMeters, scaleFactor),
    options,
  );
}
