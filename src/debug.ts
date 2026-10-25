// The surface the e2e specs and the benchmark read back. `CoolMap` implements
// it, so anything moved or renamed here breaks the type check instead of the
// browser run — which is what happened twice while splitting the class
// (`selectBuilding`, `lightingState`). Everything not in this interface is
// private to the map.

import type { LngLat, Map as MapLibreMap } from "maplibre-gl";
import type * as THREE from "three";

import type { BuildingInfo } from "./geojson_data";
import type { SceneStats } from "./perf";
import type { TileRecord } from "./tile_record";

export interface DriveStateSnapshot {
  active: boolean;
  lon: number;
  lat: number;
  heading: number;
  speed: number;
}

export interface LightingSnapshot {
  hour: number;
  night: number;
  sunIntensity: number;
}

export interface MapDebug {
  /** the MapLibre map, for specs that move the view or project a point */
  readonly map: MapLibreMap;
  /** the 3D scene, for specs that count meshes by `userData.kind` */
  readonly scene: THREE.Scene;
  /** the custom layer's camera, for specs that project a model point */
  readonly camera: THREE.Camera;
  /** the loaded tiles, keyed by tile key */
  readonly tiles: Map<string, TileRecord>;
  /** mesh, vertex and triangle counters, current frame included */
  stats(): SceneStats;
  /** where the drive car is, whether or not the mode is on */
  driveState(): DriveStateSnapshot;
  /** the current hour, the 0..1 night factor and the key-light intensity */
  lightingState(): LightingSnapshot;
  /** whether a car at this position and heading would hit a building or a
   * visible barrier */
  collisionAt(lon: number, lat: number, heading?: number): boolean;
  /** open a building's popup without clicking it */
  selectBuilding(info: BuildingInfo, lngLat: LngLat): void;
}
