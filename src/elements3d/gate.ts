import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { MeshBuilder } from "./mesh_builder";

/*
 * A gate node on a wall: two posts and a closed leaf, oriented along the
 * matched wall. One merged Lambert mesh per tile (kind `gate`); no shadows.
 */

const POST = new THREE.Color("#5f5e59");
const LEAF = new THREE.Color("#77746c");
const HEIGHT = 1.45;

export const gateMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

export function gate(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  if (f.geometry.type !== "Point") return [];
  const props = f.properties ?? {};
  const bearing = (Number(props.bearing) * Math.PI) / 180;
  const width = Math.min(Math.max(Number(props.width) || 3, 1.5), 6);
  const [x, y] = toModelCoords(
    f.geometry.coordinates as [number, number],
    originMeters,
    scaleFactor,
  );
  // the leaf runs along the wall direction u; the posts sit at its two ends
  const ux = Math.sin(bearing);
  const uy = Math.cos(bearing);
  const angle = Math.atan2(uy, ux);
  const builder = new MeshBuilder();
  builder.box(
    x - (ux * width) / 2,
    y - (uy * width) / 2,
    0,
    0.16,
    0.16,
    HEIGHT + 0.1,
    angle,
    POST,
  );
  builder.box(
    x + (ux * width) / 2,
    y + (uy * width) / 2,
    0,
    0.16,
    0.16,
    HEIGHT + 0.1,
    angle,
    POST,
  );
  builder.box(x, y, 0.08, width - 0.25, 0.08, HEIGHT - 0.1, angle, LEAF);
  const geometry = builder.geometry();
  return geometry ? [geometry] : [];
}
