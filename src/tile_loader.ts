// The tile lifecycle: which tiles the view keeps loaded, fetching them, and
// throwing away the ones that left the window. Everything the map draws hangs
// off this, so it owns the tile store and the bookkeeping around it (in-flight
// fetches and the origin generation).
//
// The loader does not know what a layer is: it reports that tiles came, went or
// were thrown away, and the map re-feeds its layers. That keeps the one thing
// that must be right — a tile and its data appearing and disappearing together
// — in a single place.

import * as THREE from "three";

import { objectsAt } from "./geojson_data";
import { getTileIndex, parseTileKey } from "./projection";
import type { TileObjects } from "./geojson_data";
import type { TileRecord } from "./tile_record";

// how many tiles beyond the centre tile stay loaded
export const RENDER_TILE_MARGIN = 3;
// the origin is recentred once the view is farther than this many tiles from it
const ORIGIN_DRIFT_TILES = 2;

export interface TileHost {
  readonly scene: THREE.Scene;
  /** the projection origin the meshes are baked against, in lon/lat */
  origin(): [number, number];
  /** where the view is now */
  viewCenter(): { lng: number; lat: number };
  /** the load-time options (imputed colors are baked into the geometry) */
  imputedColors(): boolean;
  /** the view drifted from the origin: recentre, and invalidate in-flight loads */
  onOriginDrift(center: { lng: number; lat: number }): void;
  /** tiles left the window: the layers want the new union */
  onTilesChanged(): void;
  /** one tile arrived; the facade detail hangs off it */
  onTileAdded(key: string): void;
  /** everything was dropped (a load-time option changed) */
  onReload(): void;
}

export class TileLoader {
  /** every loaded tile, keyed by tile key */
  readonly tiles = new Map<string, TileRecord>();

  // tiles with a fetch in flight; kept out of the store so a failed load does
  // not leave a permanent "loaded but empty" entry that blocks retries
  private readonly pending = new Set<string>();
  // bumped whenever the origin is reset, so a load from the old projection can
  // recognize itself as stale and drop its result
  private generation = 0;
  private readonly host: TileHost;

  constructor(host: TileHost) {
    this.host = host;
  }

  // forget the in-flight loads and everything already loaded, then refetch
  // around the view; used when a load-time option changed
  async reload(): Promise<void> {
    this.invalidate();
    this.disposeAll();
    this.host.onReload();
    await this.load(this.host.viewCenter());
  }

  // the origin was reset: results baked against the old projection are useless
  invalidate(): void {
    this.generation += 1;
    this.pending.clear();
  }

  // keep the window around `center` loaded, dropping what fell outside it
  async load(center: { lng: number; lat: number }): Promise<void> {
    // The farther the projection origin is from the visible area, the more
    // meters get squeezed into a Mercator unit (and the worse the float
    // precision), so when the view drifts too far from the origin's tile,
    // rebuild the transform around the current center.
    const [originLon, originLat] = this.host.origin();
    const [ox, oy] = getTileIndex({ lng: originLon, lat: originLat });
    const [cx, cy] = getTileIndex(center);
    if (
      Math.abs(ox - cx) > ORIGIN_DRIFT_TILES ||
      Math.abs(oy - cy) > ORIGIN_DRIFT_TILES
    ) {
      this.host.onOriginDrift(center);
    }
    let unloaded = false;
    for (const [key, record] of this.tiles) {
      const [x, y] = parseTileKey(key);
      if (
        Math.abs(x - cx) > RENDER_TILE_MARGIN ||
        Math.abs(y - cy) > RENDER_TILE_MARGIN
      ) {
        this.dispose(record);
        this.tiles.delete(key);
        unloaded = true;
      }
    }
    // the routes of an unloaded tile are gone; hand the layers the remaining
    // ones. Refeeding them only reprepares plain data, so this is cheap enough
    // to run on the moves that actually unload a tile.
    if (unloaded) this.host.onTilesChanged();
    const generation = this.generation;
    // inclusive bounds so the loaded window matches the retention window above
    // (|x - cx| <= margin), otherwise the +margin row/column is kept loaded but
    // never (re)fetched
    const loads: Promise<void>[] = [];
    for (let x = cx - RENDER_TILE_MARGIN; x <= cx + RENDER_TILE_MARGIN; x++) {
      for (let y = cy - RENDER_TILE_MARGIN; y <= cy + RENDER_TILE_MARGIN; y++) {
        loads.push(this.loadTile(x, y, generation));
      }
    }
    await Promise.all(loads);
  }

  // remove every tile, keeping the store usable
  disposeAll(): void {
    for (const record of this.tiles.values()) this.dispose(record);
    this.tiles.clear();
  }

  // run a callback over every mesh of every loaded tile
  forEachMesh(fn: (mesh: THREE.Object3D) => void): void {
    for (const record of this.tiles.values()) {
      for (const mesh of record.objects.meshes) fn(mesh);
    }
  }

  // every loaded tile's source data, flattened: the moving layers want the
  // union of all of them (the loops, the crossings, the runways)
  allObjects(): TileObjects[] {
    return [...this.tiles.values()].map((record) => record.objects);
  }

  private async loadTile(
    x: number,
    y: number,
    generation: number,
  ): Promise<void> {
    const tileKey = `${x}_${y}`;
    if (this.tiles.has(tileKey) || this.pending.has(tileKey)) return;
    this.pending.add(tileKey);
    try {
      const objects = await objectsAt(
        this.host.origin(),
        x,
        y,
        this.host.imputedColors(),
      );
      if (generation !== this.generation) {
        // the origin was reset while this tile was being computed, so the
        // meshes are in coordinates of a projection that is no longer used
        return;
      }
      // the tile may have left the render window while it was loading; if so
      // don't add it (the move handler will skip it, or has already dropped it)
      const [cx, cy] = getTileIndex(this.host.viewCenter());
      if (
        Math.abs(x - cx) > RENDER_TILE_MARGIN ||
        Math.abs(y - cy) > RENDER_TILE_MARGIN
      ) {
        return;
      }
      this.tiles.set(tileKey, { objects });
      objects.meshes.forEach((mesh) => this.host.scene.add(mesh));
      this.host.onTileAdded(tileKey);
    } catch (e) {
      // leave the tile out of the store so a later move retries it
      console.warn("failed to load tile", tileKey, e);
    } finally {
      this.pending.delete(tileKey);
    }
  }

  // remove one tile's meshes from the scene and free their geometry. The
  // materials are shared module-level singletons and are deliberately not
  // disposed; the facade detail owns its own geometry, so it goes too.
  private dispose(record: TileRecord): void {
    for (const mesh of record.objects.meshes) {
      this.host.scene.remove(mesh);
      if (mesh instanceof THREE.Mesh || mesh instanceof THREE.LineSegments) {
        mesh.geometry.dispose();
      }
    }
    this.disposeDetail(record.detail);
    record.detail = undefined;
  }

  private disposeDetail(detail: TileRecord["detail"]): void {
    disposeFacadeDetail(this.host.scene, detail);
  }
}

// The facade detail owns its own geometry (the materials are shared singletons),
// so dropping it means removing both meshes and freeing their buffers. Shared
// with the map, which drops the detail when the view zooms out.
export function disposeFacadeDetail(
  scene: THREE.Scene,
  detail: TileRecord["detail"],
): void {
  if (!detail) return;
  for (const mesh of [detail.windows, detail.balconies]) {
    if (!mesh) continue;
    scene.remove(mesh);
    mesh.geometry.dispose();
  }
}
