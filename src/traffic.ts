import * as THREE from "three";

import {
  toModelCoords,
  type TrafficLoop,
  type TrafficRun,
} from "./geojson_data";

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

// a run with its arc lengths precomputed once, at tile-load time
interface PreparedRun {
  t0: number;
  t1: number;
  coords: [number, number][];
  cum: number[];
}

interface PreparedVehicle {
  phase: number;
  v: number;
  period: number;
  // shared by every vehicle on the loop, so the geometry is prepared once
  runs: PreparedRun[];
}

// rounding of the tile's t0/t1 (3 decimals) can leave a sub-millisecond gap
const TIME_EPS = 2e-3;

function metersBetween(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function prepareRun(run: TrafficRun): PreparedRun {
  const cum = [0];
  for (let i = 1; i < run.coords.length; i++) {
    cum.push(cum[i - 1] + metersBetween(run.coords[i - 1], run.coords[i]));
  }
  return { t0: run.t0, t1: run.t1, coords: run.coords, cum };
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

// point (lon/lat) and heading at `meters` into the run
function sampleRun(
  run: PreparedRun,
  meters: number,
): { lon: number; lat: number; heading: number } {
  const total = run.cum[run.cum.length - 1];
  const d = Math.max(0, Math.min(total, meters));
  let lo = 1;
  let hi = run.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (run.cum[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  const i = lo;
  const c0 = run.cum[i - 1];
  const c1 = run.cum[i];
  const t = c1 > c0 ? (d - c0) / (c1 - c0) : 0;
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
    const geometry = new THREE.BoxGeometry(
      config.length,
      config.width,
      config.height,
    );
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
  // single identity
  setLoops(loops: TrafficLoop[]): void {
    const byId = new Map<
      string,
      {
        v: number;
        period: number;
        runs: PreparedRun[];
        vehicles: TrafficLoop["vehicles"];
      }
    >();
    for (const loop of loops) {
      let group = byId.get(loop.id);
      if (!group) {
        group = {
          v: loop.v,
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
      for (const vehicle of group.vehicles) {
        if (slot >= this.capacity) break;
        // colors are static, so they are written once here; the update loop
        // keeps every vehicle in the same slot whether it is visible or not
        this.mesh.setColorAt(slot, new THREE.Color(vehicle.color));
        vehicles.push({
          phase: vehicle.phase,
          v: group.v,
          period: group.period,
          runs: group.runs,
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
      const run = findRun(vehicle.runs, tau);
      if (!run) {
        // the tile holding this part of the loop is not loaded: hide the
        // vehicle with a zero-scale matrix but keep its slot for the color
        this.mesh.setMatrixAt(count, this.hidden);
        count++;
        continue;
      }
      const s = vehicle.v * (tau - run.t0);
      const { lon, lat, heading } = sampleRun(run, s);
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
