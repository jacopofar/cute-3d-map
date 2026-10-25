import type * as THREE from "three";
import type { TileObjects } from "./geojson_data";

// One loaded tile. `objects` is exactly what `objectsAt` returned: the merged
// scene meshes plus the source data the pickers, the drive collision and the
// moving layers read back. The facade detail is optional because it is built
// only while zoomed in and dropped when zoomed out.
export interface TileRecord {
  objects: TileObjects;
  detail?: { windows: THREE.Mesh | null; balconies: THREE.Mesh | null };
}
