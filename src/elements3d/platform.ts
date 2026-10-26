import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { unindexed } from "./flat_polygon";
import { MeshBuilder } from "./mesh_builder";
import { coloured } from "./props";

/*
 * Rail platforms: a low concrete slab with a white edge line. OSM mostly maps
 * platforms as edge lines; tilegen buffers those to a 4 m ribbon before
 * clipping, so the frontend sees polygons either way.
 *
 * One merged Lambert mesh per tile (kind `platform`); clickable with the name
 * and OSM link. No shadows.
 */

const PLATFORM_HEIGHT = 0.28;
const EDGE_WIDTH = 0.12;

const CONCRETE = new THREE.Color("#8f887c");
const EDGE = new THREE.Color("#ded9cc");

export const platformMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

type Point = [number, number];

export interface PlatformInfo {
  id?: string;
  name?: string;
  lon: number;
  lat: number;
  rings: Point[][];
}

function edgeGeometry(rings: Point[][]): THREE.BufferGeometry | null {
  const edge = new MeshBuilder();
  const z = PLATFORM_HEIGHT + 0.006;
  for (const ring of rings) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const length = Math.hypot(dx, dy);
      if (length === 0) continue;
      // a thin strip centred on the platform edge; the builder takes care of
      // which way round the four corners have to go
      const nx = (-dy / length) * EDGE_WIDTH * 0.5;
      const ny = (dx / length) * EDGE_WIDTH * 0.5;
      edge.quad(
        [ax + nx, ay + ny, z],
        [bx + nx, by + ny, z],
        [bx - nx, by - ny, z],
        [ax - nx, ay - ny, z],
        [0, 0, 1],
        EDGE,
      );
    }
  }
  return edge.geometry();
}

/** The geometry for one clipped platform. */
export function platform(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  if (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon") {
    return [];
  }
  const polygons =
    f.geometry.type === "Polygon"
      ? [f.geometry.coordinates]
      : f.geometry.coordinates;
  const out: THREE.BufferGeometry[] = [];
  for (const polygon of polygons) {
    const rings: Point[][] = polygon.map((ring) =>
      ring.map(([lon, lat]) =>
        toModelCoords([lon, lat], originMeters, scaleFactor),
      ),
    );
    if (rings.length === 0 || rings[0].length < 4) continue;
    const shape = new THREE.Shape(
      rings[0].map(([x, y]) => new THREE.Vector2(x, y)),
    );
    for (let h = 1; h < rings.length; h++) {
      shape.holes.push(
        new THREE.Path(rings[h].map(([x, y]) => new THREE.Vector2(x, y))),
      );
    }
    const extruded = new THREE.ExtrudeGeometry(shape, {
      depth: PLATFORM_HEIGHT,
      bevelEnabled: false,
      curveSegments: 1,
    });
    const top = coloured(unindexed(extruded), CONCRETE);
    const edge = edgeGeometry(rings);
    if (edge) out.push(top, edge);
    else out.push(top);
  }
  return out;
}

/** The platform polygons in a tile, for click-picking. */
export function platformInfo(f: Geojson.Feature): PlatformInfo | null {
  const props = f.properties ?? {};
  const geom = f.geometry;
  const rings: Point[][] = [];
  if (geom.type === "Polygon") {
    rings.push(geom.coordinates[0] as Point[]);
  } else if (geom.type === "MultiPolygon") {
    for (const polygon of geom.coordinates) rings.push(polygon[0] as Point[]);
  } else {
    return null;
  }
  if (rings.length === 0) return null;
  const ring = rings[0];
  let lon = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  return {
    id: typeof f.id === "string" ? f.id : undefined,
    name: typeof props.name === "string" ? props.name : undefined,
    lon: lon / ring.length,
    lat: lat / ring.length,
    rings,
  };
}
