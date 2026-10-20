import * as THREE from "three";

import { toModelCoords, type ParkedCar } from "./geojson_data";
import { CAR_TRAFFIC, vehicleGeometry } from "./traffic";

/*
 * Static parked cars along the roads, drawn with the moving cars' body.
 *
 * tilegen places the bays (parallel, perpendicular or fishbone) and emits the
 * occupied ones as [lon, lat, heading] in the tile's `parking` block. This layer
 * keeps one InstancedMesh per tile, so panning one tile over only builds the
 * tile that entered the 3x3 center window and drops the one that left. It has
 * no per-frame work at all: the cars never move, so the matrices are written
 * when a tile is added, when its spots change or when the projection origin
 * resets.
 *
 * Like the facade detail it only exists above FACADE_MIN_ZOOM, and only for the
 * tiles around the center: the fully loaded window is seven tiles across, which
 * would be hundreds of thousands of cars, almost all off-screen.
 */

// the same gate as the building windows (FACADE_MIN_ZOOM in main.ts)
export const PARKED_CAR_MIN_ZOOM = 17;

// plausible parked-car paint, with plenty of white/silver/gray
const PARKED_COLORS = [
  0xf2f2f2, 0xd9d9d9, 0xb8bcc1, 0x9aa0a6, 0x6b7280, 0x3d4350, 0x1f2933,
  0x8b1e1e, 0x1e4d8b, 0x2e7d5b, 0xb58a2a, 0xe8e2d6,
];

// a stable color from the car's position, so rebuilding the layer does not
// reshuffle the paint
function parkedColor(lon: number, lat: number): number {
  const hash =
    (Math.imul(Math.round(lon * 1e6), 73856093) ^
      Math.imul(Math.round(lat * 1e6), 19349663)) >>>
    0;
  return PARKED_COLORS[hash % PARKED_COLORS.length];
}

/** One tile's occupied bays, with the tile key the mesh is filed under. */
export interface ParkedTile {
  key: string;
  spots: ParkedCar[];
}

export interface ParkedTileDiff {
  added: string[];
  removed: string[];
  kept: string[];
}

/**
 * Which resident tiles survive the move to `wanted`. Pure so the incremental
 * bookkeeping is testable without a WebGL context: the layer only needs to know
 * what to build and what to drop.
 */
export function diffParkedTiles(
  resident: Iterable<string>,
  wanted: Iterable<string>,
): ParkedTileDiff {
  const residentSet = new Set(resident);
  const wantedSet = new Set(wanted);
  const added: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];
  for (const key of wantedSet) {
    if (residentSet.has(key)) kept.push(key);
    else added.push(key);
  }
  for (const key of residentSet) {
    if (!wantedSet.has(key)) removed.push(key);
  }
  return { added, removed, kept };
}

interface ResidentTile {
  mesh: THREE.InstancedMesh;
  // the very array the matrices were built from: a reloaded tile gets a fresh
  // array, so identity is the cheap "did this tile change?" test
  spots: ParkedCar[];
}

/**
 * One instanced mesh per tile for the parked cars around the center. The body
 * and dimensions are the moving cars' (CAR_TRAFFIC), so the two layers read as
 * the same vehicle.
 */
export class ParkedCarLayer {
  private readonly scene: THREE.Scene;
  private readonly geometry: THREE.BufferGeometry;
  // shared by every tile, so an add/remove never touches the GPU programs
  private readonly material: THREE.MeshLambertMaterial;
  private readonly tiles = new Map<string, ResidentTile>();
  private readonly dummy = new THREE.Object3D();
  private readonly capacity: number;
  private originMeters: [number, number] = [0, 0];
  private scaleFactor = 0;
  private originKnown = false;
  private enabled = true;
  // diagnostics: how many per-tile meshes were built since construction
  private built = 0;

  constructor(scene: THREE.Scene, capacity = 120_000) {
    this.scene = scene;
    // a whole cap per tile would be absurd (9 * 120k * 64 B of matrices), so
    // each mesh is sized to its own tile; `capacity` only guards a runaway tile
    this.capacity = Math.max(1, capacity);
    this.geometry = vehicleGeometry(CAR_TRAFFIC);
    // Lambert, not the moving fleet's unlit basic material: parked cars follow
    // the sun and go dark at night, while the moving cars stay bright.
    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  }

  get count(): number {
    let total = 0;
    for (const { mesh } of this.tiles.values()) total += mesh.count;
    return total;
  }

  /** The resident per-tile meshes: one draw call each. */
  get tileCount(): number {
    return this.tiles.size;
  }

  /** Per-tile meshes built since construction, for tests and diagnostics. */
  get rebuildCount(): number {
    return this.built;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const { mesh } of this.tiles.values()) mesh.visible = enabled;
  }

  /** Drop every resident tile, e.g. after a full tile reload. */
  clear(): void {
    for (const key of [...this.tiles.keys()]) this.removeTile(key);
  }

  /**
   * Make the resident meshes match `tiles` (the 3x3 center window). Tiles that
   * stay, with the same spot array and origin, are left untouched. A projection
   * origin reset changes every model coordinate, so it drops and rebuilds all.
   */
  setTiles(
    tiles: ParkedTile[],
    originMeters: [number, number],
    scaleFactor: number,
  ): void {
    const originChanged =
      !this.originKnown ||
      originMeters[0] !== this.originMeters[0] ||
      originMeters[1] !== this.originMeters[1] ||
      scaleFactor !== this.scaleFactor;
    this.originMeters = originMeters;
    this.scaleFactor = scaleFactor;
    this.originKnown = true;
    if (originChanged) this.clear();

    // empty tiles need no mesh: 9 draw calls is already the cost of this
    // design, and the empty ones would be pure overhead
    const wanted = new Map<string, ParkedCar[]>();
    for (const tile of tiles) {
      if (tile.spots.length > 0) wanted.set(tile.key, tile.spots);
    }
    const diff = diffParkedTiles(this.tiles.keys(), wanted.keys());
    for (const key of diff.removed) this.removeTile(key);
    for (const key of diff.kept) {
      const entry = this.tiles.get(key)!;
      const spots = wanted.get(key)!;
      if (entry.spots === spots) continue;
      // reloaded tile (e.g. new imputed colors): the array is new, so the
      // existing matrices may be stale or the tile may not fit any more
      this.removeTile(key);
      this.addTile(key, spots);
    }
    for (const key of diff.added) this.addTile(key, wanted.get(key)!);
  }

  private addTile(key: string, spots: ParkedCar[]): void {
    const capacity = Math.min(this.capacity, spots.length);
    const mesh = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      capacity,
    );
    mesh.userData = { kind: "parked_car", tile: key };
    mesh.castShadow = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const color = new THREE.Color();
    for (let i = 0; i < capacity; i++) {
      const spot = spots[i];
      const m = toModelCoords(
        [spot.lon, spot.lat],
        this.originMeters,
        this.scaleFactor,
      );
      this.dummy.position.set(m[0], m[1], CAR_TRAFFIC.height / 2);
      this.dummy.rotation.set(0, 0, spot.heading);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
      mesh.setColorAt(i, color.setHex(parkedColor(spot.lon, spot.lat)));
    }
    mesh.count = capacity;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // the sphere bounds this tile's own cars, so a tile that scrolls off screen
    // is culled; leaving the default (a sphere at the origin, or a stale one
    // from before a rebuild) would wrongly cull or draw it
    mesh.computeBoundingSphere();
    mesh.visible = this.enabled;
    this.scene.add(mesh);
    this.tiles.set(key, { mesh, spots });
    this.built += 1;
    if (spots.length > capacity) {
      console.warn(
        `parked cars: tile ${key} has ${spots.length} spots, capped at ${capacity}`,
      );
    }
  }

  private removeTile(key: string): void {
    const entry = this.tiles.get(key);
    if (!entry) return;
    this.scene.remove(entry.mesh);
    // frees the instance buffers only: geometry and material are shared
    entry.mesh.dispose();
    this.tiles.delete(key);
  }
}
