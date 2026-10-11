import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../geojson_data";

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
  return f.properties.height || 10;
}

// bake the per-feature color into a vertex color attribute, so many buildings
// can be merged into a single mesh (one draw call per tile, not per building)
function applyVertexColor(geometry: THREE.BufferGeometry, colorHex: string) {
  const color = new THREE.Color(colorHex);
  const count = geometry.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

export type BuildingFeature = {
  geometry: Geojson.Geometry;
  properties: {
    color?: string;
    height: number;
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
  const color = f.properties.color || "#aaaaaa";
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
