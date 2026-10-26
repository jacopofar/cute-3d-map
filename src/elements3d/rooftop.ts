import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../projection";
import { flatPolygon } from "./flat_polygon";
import { applyVertexColor } from "./vertex_color";
import { MeshBuilder } from "./mesh_builder";

/*
 * Mapped rooftop equipment: water towers, chimneys, antennas and solar panels.
 * The tile already carries the building roof height as `base`; each prop is
 * built on top of that. One merged Lambert mesh per tile (kind `rooftop`).
 */

const METAL = new THREE.Color("#6f7374");
const BRICK = new THREE.Color("#8f5b45");
const PANEL = new THREE.Color("#364f73");
const DARK = new THREE.Color("#4c4f50");

export const rooftopMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

function solarSurface(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const geometry = f.geometry;
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  const base = Math.max(0, Number(f.properties?.base) || 0);
  const parts: THREE.BufferGeometry[] = [];
  for (const polygon of polygons) {
    // a panel merges with the rest of the rooftop props, so it keeps the
    // normal and uv a MeshBuilder geometry carries
    const panel = flatPolygon(polygon, originMeters, scaleFactor, {
      z: base + 0.12,
      keepNormal: true,
      keepUv: true,
    });
    if (!panel) continue;
    applyVertexColor(panel, PANEL);
    parts.push(panel);
  }
  return parts;
}

export function rooftop(
  originMeters: [number, number],
  scaleFactor: number,
  f: Geojson.Feature,
): THREE.BufferGeometry[] {
  const geometry = f.geometry;
  const props = f.properties ?? {};
  const kind = String(props.kind ?? "antenna");
  if (
    kind === "solar" &&
    (geometry.type === "Polygon" || geometry.type === "MultiPolygon")
  ) {
    return solarSurface(originMeters, scaleFactor, f);
  }
  if (geometry.type !== "Point") return [];
  const base = Math.max(0, Number(props.base) || 0);
  const height = Math.max(0.4, Number(props.height) || 4);
  const size = Math.min(Math.max(Number(props.size) || 2, 0.4), 10);
  const [x, y] = toModelCoords(
    geometry.coordinates as [number, number],
    originMeters,
    scaleFactor,
  );
  const b = new MeshBuilder();

  if (kind === "water_tower") {
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      b.box(
        x + dx * size * 0.28,
        y + dy * size * 0.28,
        base,
        0.12,
        0.12,
        height * 0.55,
        0,
        METAL,
      );
    }
    b.box(x, y, base + height * 0.55, size, size, height * 0.45, 0, METAL);
    b.box(x, y, base + height, size * 0.85, size * 0.85, 0.25, 0, DARK);
  } else if (kind === "chimney") {
    b.box(x, y, base, size, size, height, 0, BRICK);
    b.box(x, y, base + height, size * 1.15, size * 1.15, 0.25, 0, DARK);
  } else if (kind === "solar") {
    const count = Math.min(5, Math.max(1, Math.round(size / 1.4)));
    for (let i = 0; i < count; i++) {
      b.box(
        x,
        y + (i - (count - 1) / 2) * 1.15,
        base + 0.1,
        size,
        0.9,
        0.08,
        0,
        PANEL,
      );
    }
  } else {
    // antenna / mast: a thin pole with two short crossbars
    b.box(x, y, base, 0.12, 0.12, height, 0, METAL);
    b.box(x, y, base + height * 0.6, size * 0.8, 0.08, 0.08, 0, METAL);
    b.box(x, y, base + height * 0.78, size * 0.5, 0.08, 0.08, 0, METAL);
  }
  const built = b.geometry();
  return built ? [built] : [];
}
