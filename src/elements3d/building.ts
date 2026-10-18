import * as THREE from "three";
import type Geojson from "geojson";

import { toModelCoords } from "../geojson_data";
import { parseColor } from "./color";
import {
  CHURCH_PITCH,
  CHURCH_ROOF_SHAPE,
  churchRoofColor,
  churchWallColor,
  isChurch,
} from "./church";
import { roofGeometry } from "./roof";
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

// bake the per-feature color into a vertex color attribute, so many buildings
// can be merged into a single mesh (one draw call per tile, not per building)
export type BuildingFeature = {
  geometry: Geojson.Geometry;
  properties: {
    color?: string;
    // tilegen writes a number; allow a string here so hand-written GeoJSON
    // like "12 m" doesn't slip through as NaN
    height?: number | string;
    // real (or tilegen-imputed) roof data, and which fields were imputed
    roof_shape?: string;
    roof_color?: string;
    imputed?: string[];
    // the OSM building value and, for a place of worship, its religion: the
    // marker the church look is keyed on
    building?: string;
    religion?: string;
  };
};

// what one building contributes: the extruded walls, and its roof as a separate
// geometry so the roof can be switched off on its own
export interface BuildingGeometry {
  walls: THREE.BufferGeometry;
  roof: THREE.BufferGeometry | null;
}

// whether a field was sampled rather than tagged
function isImputed(f: BuildingFeature, field: string): boolean {
  return (f.properties.imputed ?? []).includes(field);
}

// the building's first footprint coordinate, as a string: the seed the church
// tones are drawn from (church.ts documents it)
function anchorOf(f: BuildingFeature): string {
  const geom = f.geometry;
  if (geom.type === "Polygon") {
    const first = geom.coordinates[0]?.[0];
    return first ? first.join(",") : "";
  }
  if (geom.type === "MultiPolygon") {
    const first = geom.coordinates[0]?.[0]?.[0];
    return first ? first.join(",") : "";
  }
  return "";
}

export function building(
  originMeters: [number, number],
  scaleFactor: number,
  fin: Geojson.Feature,
  imputedColors = true,
): BuildingGeometry[] {
  const f = fin as unknown as BuildingFeature;
  const height = geoJSONtoHeight(f);
  const extrudeSettings = {
    depth: height,
    bevelEnabled: false,
  };
  const church = isChurch(f.properties);
  const anchor = anchorOf(f);
  // A church keeps its own stone tone even when the imputed colors are off: the
  // palette is this feature's look, not a value tilegen drew from the dataset's
  // distribution, and without it a church would be a plain grey block again.
  // A real building:colour still wins over it.
  const churchWalls =
    church && (f.properties.color === undefined || isImputed(f, "color"));
  const color = churchWalls
    ? new THREE.Color(churchWallColor(anchor))
    : !imputedColors && isImputed(f, "color")
      ? new THREE.Color(DEFAULT_BUILDING_COLOR)
      : parseColor(f.properties.color, DEFAULT_BUILDING_COLOR);
  // slate over a sampled roof color too, for the same reason: a church roof is
  // part of the look
  const churchRoof =
    church &&
    (f.properties.roof_color === undefined || isImputed(f, "roof_color"));
  const roofColor: string | undefined = churchRoof
    ? churchRoofColor(anchor)
    : !imputedColors && isImputed(f, "roof_color")
      ? undefined
      : f.properties.roof_color;
  const roofFor = (ring: Geojson.Position[][]): THREE.BufferGeometry | null =>
    roofGeometry(
      ring.map((r) => r.map((c): [number, number] => [c[0], c[1]])),
      height,
      originMeters,
      scaleFactor,
      // a church gets a gabled roof ... a footprint too complex for one (a
      // courtyard, a concave outline) still stays flat inside roofGeometry
      church ? CHURCH_ROOF_SHAPE : f.properties.roof_shape,
      roofColor,
      // ... pitched steeper than the default
      church ? CHURCH_PITCH : 1,
    );
  const withRoof = (
    ring: Geojson.Position[][],
    geometry: THREE.BufferGeometry,
  ) => ({ walls: geometry, roof: roofFor(ring) });

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
      return withRoof(polygon, geometry);
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
    return [withRoof(f.geometry.coordinates, geometry)];
  }
  throw Error(`Cannot have building of type ${f.geometry.type}`);
}
