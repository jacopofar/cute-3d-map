import * as THREE from "three";

import {
  toModelCoords,
  type TrafficLoop,
  type TrafficRun,
} from "./geojson_data";
import {
  crossingShift,
  crossingsAlongLoop,
  coordKey,
  type PreparedCrossing,
  type PreparedRun,
} from "./traffic_math";

// a fleet of precomputed vehicles: one InstancedMesh of boxes, placed from the
// route data every frame
export interface TrafficFleetConfig {
  length: number; // vehicle box size, meters
  width: number;
  height: number;
  maxVehicles: number;
}

export const CAR_TRAFFIC: TrafficFleetConfig = {
  length: 8 / 3,
  width: 4 / 3,
  height: 1,
  // long random loops mean many vehicles pass through the loaded window at
  // once; keep enough slots that none are dropped
  maxVehicles: 120000,
};

// trains/trams: longer and slimmer than a car (matches the old TRAIN_FLEET)
export const TRAIN_TRAFFIC: TrafficFleetConfig = {
  length: 15,
  width: 1.5,
  height: 2,
  maxVehicles: 500,
};

interface PreparedVehicle {
  phase: number;
  period: number;
  // shared by every vehicle on the loop, so the geometry is prepared once
  runs: PreparedRun[];
  // shared too: the loop's crossings, matched from the tile's point features
  crossings: PreparedCrossing[];
}

// rounding of the tile's t0/t1 (3 decimals) can leave a sub-millisecond gap
const TIME_EPS = 2e-3;

function prepareRun(run: TrafficRun): PreparedRun {
  return { t0: run.t0, t1: run.t1, coords: run.coords, times: run.times };
}

// the run whose [t0, t1) contains tau, or undefined when the vehicle is in a
// part of the loop whose tile is not loaded. `runs` is sorted by t0.
function findRun(runs: PreparedRun[], tau: number): PreparedRun | undefined {
  let lo = 0;
  let hi = runs.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid].t0 <= tau) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return undefined;
  const run = runs[best];
  return tau <= run.t1 + TIME_EPS ? run : undefined;
}

// point (lon/lat) and heading at `seconds` into the run. The run's speed is
// constant between two keyframes, so interpolating them by time is exact.
function sampleRun(
  run: PreparedRun,
  seconds: number,
): { lon: number; lat: number; heading: number } {
  const total = run.times[run.times.length - 1];
  const d = Math.max(0, Math.min(total, seconds));
  let lo = 1;
  let hi = run.times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (run.times[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  const i = lo;
  const t0 = run.times[i - 1];
  const t1 = run.times[i];
  const t = t1 > t0 ? (d - t0) / (t1 - t0) : 0;
  const a = run.coords[i - 1];
  const b = run.coords[i];
  const lon = a[0] + (b[0] - a[0]) * t;
  const lat = a[1] + (b[1] - a[1]) * t;
  // heading in model space; angles are origin/scale independent, so a local
  // equirectangular projection is enough
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const heading = Math.atan2(
    (b[1] - a[1]) * 110540,
    (b[0] - a[0]) * cosLat * 111320,
  );
  return { lon, lat, heading };
}

// the body shared by moving and parked cars: a simple box in the fleet's
// dimensions, so the two layers always match
export function vehicleGeometry(
  config: TrafficFleetConfig,
): THREE.BufferGeometry {
  return new THREE.BoxGeometry(config.length, config.width, config.height);
}

/**
 * Renders precomputed traffic: every vehicle is a pure function of wall-clock
 * time, so there is no simulation to advance, nothing to rebuild when a tile
 * arrives and no state to lose when one leaves. Tile load/unload only changes
 * which loops are present (setLoops).
 */
export class TrafficRenderer {
  private readonly mesh: THREE.InstancedMesh;
  private readonly config: TrafficFleetConfig;
  private readonly dummy = new THREE.Object3D();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly capacity: number;
  private readonly now: () => number;
  private vehicles: PreparedVehicle[] = [];
  // when disabled (map zoomed out) the mesh is hidden and the per-frame update
  // is skipped
  enabled = true;

  constructor(
    scene: THREE.Scene,
    config: TrafficFleetConfig,
    now: () => number = () => Date.now() / 1000,
  ) {
    this.config = config;
    this.now = now;
    this.capacity = Math.max(1, config.maxVehicles);
    const geometry = vehicleGeometry(config);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geometry, material, this.capacity);
    this.mesh.count = 0;
    // instances move every frame, so frustum culling against stale bounds
    // would hide them
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.mesh.visible = enabled;
  }

  // live vehicle count, for the perf benchmark
  get count(): number {
    return this.vehicles.length;
  }

  // the union of the loaded tiles' traffic; the per-tile pieces of one loop
  // (same id) are merged here so a vehicle crossing a tile boundary keeps a
  // single identity. `crossingPoints` are the tile features; they are matched to
  // each loop's vertices so a vehicle can slow down through them.
  setLoops(loops: TrafficLoop[], crossingPoints: [number, number][]): void {
    const keys = new Set(crossingPoints.map((p) => coordKey(p[0], p[1])));
    const byId = new Map<
      string,
      {
        period: number;
        runs: PreparedRun[];
        vehicles: TrafficLoop["vehicles"];
      }
    >();
    for (const loop of loops) {
      let group = byId.get(loop.id);
      if (!group) {
        group = {
          period: loop.period,
          runs: [],
          vehicles: loop.vehicles,
        };
        byId.set(loop.id, group);
      }
      for (const run of loop.runs) group.runs.push(prepareRun(run));
    }

    const vehicles: PreparedVehicle[] = [];
    let slot = 0;
    for (const group of byId.values()) {
      if (slot >= this.capacity) break;
      group.runs.sort((a, b) => a.t0 - b.t0);
      const crossings = crossingsAlongLoop(group.runs, keys);
      for (const vehicle of group.vehicles) {
        if (slot >= this.capacity) break;
        // colors are static, so they are written once here; the update loop
        // keeps every vehicle in the same slot whether it is visible or not
        this.mesh.setColorAt(slot, new THREE.Color(vehicle.color));
        vehicles.push({
          phase: vehicle.phase,
          period: group.period,
          runs: group.runs,
          crossings,
        });
        slot++;
      }
    }
    if (slot >= this.capacity) {
      console.warn("traffic: vehicle capacity exceeded, dropping routes");
    }
    this.vehicles = vehicles;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  // place every vehicle for the current wall-clock phase. Positions are
  // recomputed in model space every frame because the projection origin can be
  // reset while panning (resetOrigin in main.ts).
  update(originMeters: [number, number], scaleFactor: number): void {
    if (!this.enabled) return;
    const now = this.now();
    let count = 0;
    for (const vehicle of this.vehicles) {
      const period = vehicle.period;
      let tau = (now + vehicle.phase * period) % period;
      if (tau < 0) tau += period;
      // the cosmetic speed bump through crossings shifts which point of the
      // loop is drawn, but returns to zero, so the schedule is untouched
      let drawn = tau + crossingShift(tau, vehicle.crossings, now);
      drawn = ((drawn % period) + period) % period;
      const run = findRun(vehicle.runs, drawn);
      if (!run) {
        // the tile holding this part of the loop is not loaded: hide the
        // vehicle with a zero-scale matrix but keep its slot for the color
        this.mesh.setMatrixAt(count, this.hidden);
        count++;
        continue;
      }
      const seconds = drawn - run.t0;
      const { lon, lat, heading } = sampleRun(run, seconds);
      const m = toModelCoords([lon, lat], originMeters, scaleFactor);
      this.dummy.position.set(m[0], m[1], this.config.height / 2);
      this.dummy.rotation.set(0, 0, heading);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(count, this.dummy.matrix);
      count++;
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
