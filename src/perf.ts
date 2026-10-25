// Frame timing, the diagnostic report and the read-only scene counters. None
// of it drives the map: the counters are what the benchmark (perf/) and the
// perf page read back, and the report is a fire-and-forget POST, so it can live
// outside `CoolMap` and be read on its own.

import * as THREE from "three";

import type { NightLights } from "./night_lights";
import type { ParkedCarLayer } from "./parked_cars";
import type { TrafficRenderer } from "./traffic";
import type { TileRecord } from "./tile_record";
import { checkboxStates } from "./ui/checkboxes";

// Build-time opt-in: without an endpoint the reporting path is a no-op and no
// request leaves the page. Both names are accepted so an existing .env with
// either spelling keeps working.
export const PERF_ENDPOINT = String(
  import.meta.env.PERF_ENDPOINT ?? import.meta.env.VITE_PERF_ENDPOINT ?? "",
).trim();

// the browser name is enough for the report; the full UA string is noisy and
// the payload is meant to be grouped, not fingerprinted
function browserName(): string {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Unknown";
}

function webGPUSupported(): boolean {
  // WebGPU is exposed as navigator.gpu; the property is absent on browsers that
  // only implement WebGL
  return "gpu" in navigator;
}

// a two-second window is long enough to smooth a hitch but short enough to
// follow a pan or a toggle
const FPS_WINDOW_MS = 2000;

export class PerfReporter {
  private readonly frameTimes: number[] = [];
  private fps = 0;

  recordFrame(now: number): void {
    if (!PERF_ENDPOINT) return;
    this.frameTimes.push(now);
    const cutoff = now - FPS_WINDOW_MS;
    while (this.frameTimes.length > 1 && this.frameTimes[0] < cutoff) {
      this.frameTimes.shift();
    }
    const elapsed = now - this.frameTimes[0];
    this.fps =
      elapsed > 0 ? ((this.frameTimes.length - 1) * 1000) / elapsed : 0;
  }

  report(extra: Record<string, unknown> = {}): void {
    if (!PERF_ENDPOINT) return;
    // diagnostics must never break the map: a missing collector or an offline
    // page is a no-op, not an unhandled rejection
    void fetch(PERF_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        browser: browserName(),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        webgpu: webGPUSupported(),
        fps: Math.round(this.fps * 10) / 10,
        checkboxes: checkboxStates(),
        ...extra,
      }),
      keepalive: true,
    }).catch(() => {});
  }
}

export interface SceneStats {
  tiles: number;
  meshes: number;
  vertices: number;
  drawCalls: number;
  triangles: number;
  byKind: Record<
    string,
    { meshes: number; vertices: number; triangles: number }
  >;
  buildings: number;
  vehicles: number;
  trains: number;
  facadeTiles: number;
  facadeVertices: number;
  parkedCars: number;
  parkedCarTiles: number;
  parkedCarMeshes: number;
  parkedCarTriangles: number;
  nightLightTiles: number;
  nightLightMeshes: number;
  vehiclesDrawn: number;
  trainsDrawn: number;
  buses: number;
  trams: number;
  busesDrawn: number;
  tramsDrawn: number;
}

// the moving layers carry their own counts; they are optional because a fleet
// only exists once its traffic is switched on
export interface StatsLayers {
  cars?: TrafficRenderer;
  trains?: TrafficRenderer;
  buses?: TrafficRenderer;
  trams?: TrafficRenderer;
  parkedCars?: ParkedCarLayer;
  nightLights?: NightLights;
  /** last frame's scene, captured before the bloom pass overwrites
   * renderer.info */
  drawCalls: number;
  triangles: number;
}

export function sceneStats(
  tiles: Map<string, TileRecord>,
  layers: StatsLayers,
): SceneStats {
  let meshes = 0;
  let vertices = 0;
  let buildings = 0;
  let facadeTiles = 0;
  let facadeVertices = 0;
  const byKind: SceneStats["byKind"] = {};
  for (const { objects, detail } of tiles.values()) {
    meshes += objects.meshes.length;
    buildings += objects.buildings.length;
    for (const object of objects.meshes) {
      if (
        !(object instanceof THREE.Mesh) &&
        !(object instanceof THREE.LineSegments)
      ) {
        continue;
      }
      const kind = (object.userData.kind as string) ?? "other";
      const bucket = (byKind[kind] ??= {
        meshes: 0,
        vertices: 0,
        triangles: 0,
      });
      const position = object.geometry.getAttribute("position");
      const count = position ? position.count : 0;
      bucket.meshes += 1;
      bucket.vertices += count;
      bucket.triangles +=
        object instanceof THREE.LineSegments
          ? 0
          : object.geometry.index
            ? object.geometry.index.count / 3
            : count / 3;
      vertices += count;
    }
    for (const mesh of [detail?.windows, detail?.balconies]) {
      if (!mesh) continue;
      facadeTiles += 1;
      facadeVertices += mesh.geometry.getAttribute("position")?.count ?? 0;
    }
  }
  return {
    tiles: tiles.size,
    meshes,
    vertices,
    drawCalls: layers.drawCalls,
    triangles: layers.triangles,
    byKind,
    buildings,
    vehicles: layers.cars?.count ?? 0,
    trains: layers.trains?.count ?? 0,
    facadeTiles,
    facadeVertices,
    parkedCars: layers.parkedCars?.count ?? 0,
    parkedCarTiles: layers.parkedCars?.tileCount ?? 0,
    parkedCarMeshes: layers.parkedCars?.meshCount ?? 0,
    parkedCarTriangles: layers.parkedCars?.triangles ?? 0,
    nightLightTiles: layers.nightLights?.tileCount ?? 0,
    nightLightMeshes: layers.nightLights?.meshCount ?? 0,
    vehiclesDrawn: layers.cars?.drawnCount ?? 0,
    trainsDrawn: layers.trains?.drawnCount ?? 0,
    buses: layers.buses?.count ?? 0,
    trams: layers.trams?.count ?? 0,
    busesDrawn: layers.buses?.drawnCount ?? 0,
    tramsDrawn: layers.trams?.drawnCount ?? 0,
  };
}
