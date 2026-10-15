import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../geojson_data";
import { applyVertexColor } from "./vertex_color";

function coordsToShape(
  coords: Geojson.Position[][],
  originMeters: [number, number],
  scaleFactor: number,
) {
  const polyPoints: [number, number][] = coords[0].map((c) =>
    toModelCoords([c[0], c[1]], originMeters, scaleFactor),
  );

  const featureBaseShape = new THREE.Shape(
    polyPoints.map((pp) => new THREE.Vector2(pp[0], pp[1])),
  );
  // now the holes, if any
  for (let hi = 1; hi < coords.length; hi++) {
    const holePoints = coords[hi].map((c) =>
      toModelCoords([c[0], c[1]], originMeters, scaleFactor),
    );
    featureBaseShape.holes.push(
      new THREE.Path(holePoints.map((pp) => new THREE.Vector2(pp[0], pp[1]))),
    );
  }
  return featureBaseShape;
}

function geoJSONtoHeight(f: BuildingFeature): number {
  // tilegen emits a number, but be defensive: height can be absent, or a
  // string carrying a unit ("12 m") in hand-written GeoJSON
  const h = Number(f.properties.height);
  return Number.isFinite(h) && h > 0 ? h : 10;
}

const DEFAULT_BUILDING_COLOR = "#aaaaaa";
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL_COLOR = /^(?:rgb|rgba|hsl|hsla)\(/i;

// OSM building:colour is free text: it can be a semicolon list of two colors
// ("black;white"), carry spaces, or be a name THREE.Color does not know. Passing
// those straight to THREE.Color logs "Unknown color" and leaves the geometry
// white, so take the first entry and check it before trusting it.
function parseBuildingColor(value: string | undefined): THREE.Color {
  const candidate = value?.split(";")[0]?.trim();
  if (candidate) {
    const named = candidate.toLowerCase() in THREE.Color.NAMES;
    if (
      HEX_COLOR.test(candidate) ||
      FUNCTIONAL_COLOR.test(candidate) ||
      named
    ) {
      return new THREE.Color(candidate);
    }
  }
  return new THREE.Color(DEFAULT_BUILDING_COLOR);
}

// bake the per-feature color into a vertex color attribute, so many buildings
// can be merged into a single mesh (one draw call per tile, not per building)
export type BuildingFeature = {
  geometry: Geojson.Geometry;
  properties: {
    color?: string;
    // tilegen writes a number; allow a string here so hand-written GeoJSON
    // like "12 m" doesn't slip through as NaN
    height?: number | string;
  };
};

export function building(
  originMeters: [number, number],
  scaleFactor: number,
  fin: Geojson.Feature,
): THREE.BufferGeometry[] {
  const f = fin as unknown as BuildingFeature;
  const extrudeSettings = {
    depth: geoJSONtoHeight(f),
    bevelEnabled: false,
  };
  const color = parseBuildingColor(f.properties.color);
  if (f.geometry.type === "MultiPolygon") {
    return f.geometry.coordinates.map((polygon) => {
      const featureBaseShape = coordsToShape(
        polygon,
        originMeters,
        scaleFactor,
      );
      const geometry = new THREE.ExtrudeGeometry(
        featureBaseShape,
        extrudeSettings,
      );
      applyVertexColor(geometry, color);
      return geometry;
    });
  }
  if (f.geometry.type === "Polygon") {
    const featureBaseShape = coordsToShape(
      f.geometry.coordinates,
      originMeters,
      scaleFactor,
    );
    const geometry = new THREE.ExtrudeGeometry(
      featureBaseShape,
      extrudeSettings,
    );
    applyVertexColor(geometry, color);
    return [geometry];
  }
  throw Error(`Cannot have building of type ${f.geometry.type}`);
}
