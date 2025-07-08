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

function geoJSONtoMaterial(f: BuildingFeature): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({
    color: f.properties.color || "#aaaaaa",
    // transparent: true,
    // opacity: 0.9,
  });
}

class Building extends THREE.Mesh {
  constructor(geometry: THREE.ExtrudeGeometry, material: THREE.Material) {
    super(geometry, material);
  }
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
): THREE.Object3D[] {
  const f = fin as unknown as BuildingFeature;
  const extrudeSettings = {
    depth: geoJSONtoHeight(f),
    bevelEnabled: false,
  };
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
      return new Building(geometry, geoJSONtoMaterial(f));
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
    return [new Building(geometry, geoJSONtoMaterial(f))];
  }
  throw Error(`Cannot have building of type ${f.geometry.type}`);
}
