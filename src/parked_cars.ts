import * as THREE from "three";

import { toModelCoords, type ParkedCar } from "./geojson_data";
import { CAR_TRAFFIC, simpleVehicleGeometry, vehicleGeometry } from "./traffic";

/*
 * Static parked cars along the roads, drawn with the moving cars' body.
 *
 * tilegen authors parking rows (the kerb line, parallel/perpendicular/fishbone,
 * pitch and side); `parking_layout.ts` places the occupied cars. This layer
 * keeps one InstancedMesh per tile and distance bucket, so panning one tile over
 * only builds the tile that entered the 3x3 center window and drops the one that
 * left. It has no per-frame work at all: the cars never move, so the matrices are
 * written when a tile is added, when its spots change or when the projection
 * origin resets.
 *
 * Like the facade detail it only exists above FACADE_MIN_ZOOM, and only for the
 * tiles around the center: the fully loaded window is seven tiles across, which
 * would be hundreds of thousands of cars, almost all off-screen.
 */

// the same gate as the building windows (FACADE_MIN_ZOOM in main.ts)
export const PARKED_CAR_MIN_ZOOM = 17;

// Cars beyond this distance from the view center are a box. At the parked-car
// gate the far ones are a few pixels tall, while 71k detailed bodies cost about
// 3.7M triangles; 600 m is roughly the visible ground at zoom 18.
export const PARKED_CAR_DETAIL_RADIUS = 600;

// Reclassify only after the view center moved this far: rebuilding every tile on
// every debounced move would trade the triangle saving for a pan hitch.
export const PARKED_CAR_LOD_STEP = 250;

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

/**
 * A quantized version of the view center: the distance buckets only change when
 * the camera has moved a meaningful distance, not on every debounced move.
 */
function lodKeyOf(center: [number, number] | undefined): string {
  if (!center) return "all-near";
  return `${Math.round(center[0] / PARKED_CAR_LOD_STEP)}:${Math.round(center[1] / PARKED_CAR_LOD_STEP)}`;
}

interface ResidentTile {
  // the very array the matrices were built from: a reloaded tile gets a fresh
  // array, so identity is the cheap "did this tile change?" test
  spots: ParkedCar[];
  // one bucket per distance; either can be null when empty
  near: THREE.InstancedMesh | null;
  far: THREE.InstancedMesh | null;
  lodKey: string;
}

/**
 * The parked cars around the center, in one InstancedMesh per tile and distance
 * bucket. The body and dimensions are the moving cars' (CAR_TRAFFIC), so the two
 * layers read as the same vehicle.
 */
export class ParkedCarLayer {
  private readonly scene: THREE.Scene;
  private readonly geometry: THREE.BufferGeometry;
  private readonly simpleGeometry: THREE.BufferGeometry;
  // shared by every tile, so an add/remove never touches the GPU programs
  private readonly material: THREE.MeshLambertMaterial;
  private readonly tiles = new Map<string, ResidentTile>();
  private readonly dummy = new THREE.Object3D();
  private readonly capacity: number;
  private originMeters: [number, number] = [0, 0];
  private scaleFactor = 0;
  private originKnown = false;
  private enabled = true;
  // diagnostics: how many per-tile builds happened since construction
  private built = 0;

  constructor(scene: THREE.Scene, capacity = 120_000) {
    this.scene = scene;
    // a whole cap per tile would be absurd (9 * 120k * 64 B of matrices), so
    // each mesh is sized to its own bucket; `capacity` only guards a runaway
    // tile
    this.capacity = Math.max(1, capacity);
    this.geometry = vehicleGeometry(CAR_TRAFFIC);
    this.simpleGeometry = simpleVehicleGeometry(CAR_TRAFFIC);
    // Lambert, not the moving fleet's unlit basic material: parked cars follow
    // the sun and go dark at night, while the moving cars stay bright.
    // vertexColors carries the shared body's chassis/glass/wheel colors; three
    // multiplies them by the per-instance paint.
    this.material = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      vertexColors: true,
    });
  }

  get count(): number {
    let total = 0;
    for (const { near, far } of this.tiles.values()) {
      total += near?.count ?? 0;
      total += far?.count ?? 0;
    }
    return total;
  }

  /** The resident per-tile meshes (near + far): one draw call each. */
  get meshCount(): number {
    let total = 0;
    for (const { near, far } of this.tiles.values()) {
      if (near) total += 1;
      if (far) total += 1;
    }
    return total;
  }

  /** The resident tiles, independent of how many buckets each one uses. */
  get tileCount(): number {
    return this.tiles.size;
  }

  /** Triangles the resident bodies draw (near and far buckets). */
  get triangles(): number {
    let total = 0;
    for (const { near, far } of this.tiles.values()) {
      for (const mesh of [near, far]) {
        if (!mesh) continue;
        const position = mesh.geometry.getAttribute("position");
        const perInstance = mesh.geometry.index
          ? mesh.geometry.index.count / 3
          : position.count / 3;
        total += perInstance * mesh.count;
      }
    }
    return total;
  }

  /** Per-tile builds since construction, for tests and diagnostics. */
  get rebuildCount(): number {
    return this.built;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const { near, far } of this.tiles.values()) {
      if (near) near.visible = enabled;
      if (far) far.visible = enabled;
    }
  }

  /** Drop every resident tile, e.g. after a full tile reload. */
  clear(): void {
    for (const key of [...this.tiles.keys()]) this.removeTile(key);
  }

  /**
   * Make the resident meshes match `tiles` (the 3x3 center window). Tiles that
   * stay, with the same spot array and LOD bucket, are left untouched. A
   * projection origin reset changes every model coordinate, so it drops and
   * rebuilds all. `detailCenter` is the view center in model meters; without it
   * every car gets the detailed body (handy for tests).
   */
  setTiles(
    tiles: ParkedTile[],
    originMeters: [number, number],
    scaleFactor: number,
    detailCenter?: [number, number],
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

    const lodKey = lodKeyOf(detailCenter);
    // empty tiles need no mesh: the draw calls are the cost of this design
    const wanted = new Map<string, ParkedCar[]>();
    for (const tile of tiles) {
      if (tile.spots.length > 0) wanted.set(tile.key, tile.spots);
    }
    const diff = diffParkedTiles(this.tiles.keys(), wanted.keys());
    for (const key of diff.removed) this.removeTile(key);
    for (const key of diff.kept) {
      const entry = this.tiles.get(key)!;
      const spots = wanted.get(key)!;
      if (entry.spots === spots && entry.lodKey === lodKey) continue;
      // a reloaded tile (fresh array) or a moved LOD center: rebuild just this
      // tile, keeping the others untouched
      this.removeTile(key);
      this.addTile(key, spots, lodKey, detailCenter);
    }
    for (const key of diff.added) {
      this.addTile(key, wanted.get(key)!, lodKey, detailCenter);
    }
  }

  private addTile(
    key: string,
    spots: ParkedCar[],
    lodKey: string,
    detailCenter?: [number, number],
  ): void {
    let nearCount = spots.length;
    if (detailCenter) {
      nearCount = 0;
      for (const spot of spots) {
        const m = toModelCoords(
          [spot.lon, spot.lat],
          this.originMeters,
          this.scaleFactor,
        );
        if (
          Math.hypot(m[0] - detailCenter[0], m[1] - detailCenter[1]) <=
          PARKED_CAR_DETAIL_RADIUS
        ) {
          nearCount++;
        }
      }
    }
    const farCount = spots.length - nearCount;
    const near = this.makeMesh(
      key,
      "near",
      this.geometry,
      Math.min(this.capacity, nearCount),
    );
    const far = this.makeMesh(
      key,
      "far",
      this.simpleGeometry,
      Math.min(this.capacity, farCount),
    );

    const color = new THREE.Color();
    let nearWritten = 0;
    let farWritten = 0;
    for (const spot of spots) {
      const m = toModelCoords(
        [spot.lon, spot.lat],
        this.originMeters,
        this.scaleFactor,
      );
      const isNear =
        !detailCenter ||
        Math.hypot(m[0] - detailCenter[0], m[1] - detailCenter[1]) <=
          PARKED_CAR_DETAIL_RADIUS;
      const mesh = isNear ? near : far;
      if (!mesh) continue;
      const index = isNear ? nearWritten : farWritten;
      if (index >= mesh.instanceMatrix.count) continue;
      this.dummy.position.set(m[0], m[1], CAR_TRAFFIC.height / 2);
      this.dummy.rotation.set(0, 0, spot.heading);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(index, this.dummy.matrix);
      mesh.setColorAt(index, color.setHex(parkedColor(spot.lon, spot.lat)));
      if (isNear) nearWritten++;
      else farWritten++;
    }
    this.finishMesh(near, nearWritten);
    this.finishMesh(far, farWritten);

    this.tiles.set(key, { spots, near, far, lodKey });
    this.built += 1;
    if (spots.length > this.capacity) {
      console.warn(
        `parked cars: tile ${key} has ${spots.length} spots, capped at ${this.capacity}`,
      );
    }
  }

  private makeMesh(
    tileKey: string,
    lod: "near" | "far",
    geometry: THREE.BufferGeometry,
    capacity: number,
  ): THREE.InstancedMesh | null {
    if (capacity <= 0) return null;
    const mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    mesh.userData = { kind: "parked_car", tile: tileKey, lod };
    mesh.castShadow = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.count = 0;
    mesh.visible = this.enabled;
    this.scene.add(mesh);
    return mesh;
  }

  private finishMesh(mesh: THREE.InstancedMesh | null, count: number): void {
    if (!mesh) return;
    mesh.count = count;
    if (count === 0) {
      // an empty bucket is not worth a draw call, but keep it in the scene so
      // the tile's bookkeeping stays symmetric; this only happens with a tiny
      // test capacity, since empty tiles are filtered out earlier
      mesh.visible = false;
      return;
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // the sphere bounds this bucket's own cars, so a tile that scrolls off
    // screen is culled; leaving the default (a sphere at the origin, or a stale
    // one from before a rebuild) would wrongly cull or draw it
    mesh.computeBoundingSphere();
    mesh.visible = this.enabled;
  }

  private removeTile(key: string): void {
    const entry = this.tiles.get(key);
    if (!entry) return;
    for (const mesh of [entry.near, entry.far]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      // frees the instance buffers only: geometry and material are shared
      mesh.dispose();
    }
    this.tiles.delete(key);
  }
}
