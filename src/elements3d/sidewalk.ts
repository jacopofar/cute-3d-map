import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type Geojson from "geojson";

import { toModelCoords } from "../geojson_data";

/*
 * Sidewalk slabs authored as centre lines by tilegen. Each segment gets a flat
 * top and two vertical kerb faces; junction gaps and splits are already in the
 * tile line, so nothing is clipped against the road network here.
 *
 * One merged Lambert mesh per tile (kind `sidewalk`), no shadows, no popup.
 */

const TOP = 0.14;
const SLAB = new THREE.Color("#b8b2a7");
const KERB = new THREE.Color("#8b877f");

export const sidewalkMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

type Point = [number, number];

function polygonGeometry(
  rings: Geojson.Position[][],
  originMeters: [number, number],
  scaleFactor: number,
): THREE.BufferGeometry | null {
  const points = rings[0]?.map(([lon, lat]) =>
    toModelCoords([lon, lat], originMeters, scaleFactor),
  );
  if (!points || points.length < 3) return null;
  const shape = new THREE.Shape(
    points.map(([x, y]) => new THREE.Vector2(x, y)),
  );
  for (let h = 1; h < rings.length; h++) {
    const hole = rings[h].map(([lon, lat]) =>
      toModelCoords([lon, lat], originMeters, scaleFactor),
    );
    shape.holes.push(
      new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))),
    );
  }
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: TOP,
    bevelEnabled: false,
    curveSegments: 1,
  });
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const normals = flat.getAttribute("normal");
  const colors = new Float32Array(normals.count * 3);
  for (let i = 0; i < normals.count; i++) {
    // the extruded caps are the top/bottom; everything else is a kerb face
    const color = normals.getZ(i) > 0.5 ? SLAB : KERB;
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.dispose();
  return flat;
}

/** The geometry for one tile's authored sidewalk polygon. */
export function sidewalk(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const geom = f.geometry;
  const polygons =
    geom.type === "Polygon"
      ? [geom.coordinates]
      : geom.type === "MultiPolygon"
        ? geom.coordinates
        : [];
  const parts: THREE.BufferGeometry[] = [];
  for (const polygon of polygons) {
    const geometry = polygonGeometry(polygon, originMeters, scaleFactor);
    if (geometry) parts.push(geometry);
  }
  if (parts.length === 0) return [];
  if (parts.length === 1) return parts;
  const merged = BufferGeometryUtils.mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return merged ? [merged] : [];
}
