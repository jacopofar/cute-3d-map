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
import { vehicleGeometry, type VehicleBodySize } from "./vehicle_body";

export { vehicleGeometry };

// a fleet of precomputed vehicles: one InstancedMesh of car bodies, placed from
// the route data every frame
export interface TrafficFleetConfig extends VehicleBodySize {
  maxVehicles: number;
}

export const CAR_TRAFFIC: TrafficFleetConfig = {
  length: 8 / 3,
  width: 4 / 3,
  height: 1,
  body: "car",
  // long random loops mean many vehicles pass through the loaded window at
  // once; keep enough slots that none are dropped
  maxVehicles: 120000,
};

// trains/trams: longer and slimmer than a car (matches the old TRAIN_FLEET)
export const TRAIN_TRAFFIC: TrafficFleetConfig = {
  length: 15,
  width: 1.5,
  height: 2,
  body: "train",
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

// the visible lon/lat window; a run outside it is not worth sampling
export interface TrafficView {
  west: number;
  south: number;
  east: number;
  north: number;
}

// vehicles update at ~30 Hz. Two slices are placed per cycle, one per update,
// so the work is spread over frames instead of a spike every other one.
const UPDATE_HZ = 30;
const SLICES = 2;
const SLICE_MS = 1000 / UPDATE_HZ / SLICES;
// vehicles just outside the view can enter it on the next pan; keep a margin
// before culling them
const VIEW_PADDING = 0.08;

function paddedView(view: TrafficView): TrafficView {
  const padLon = (view.east - view.west) * VIEW_PADDING;
  const padLat = (view.north - view.south) * VIEW_PADDING;
  return {
    west: view.west - padLon,
    east: view.east + padLon,
    south: view.south - padLat,
    north: view.north + padLat,
  };
}

function runInView(run: PreparedRun, view: TrafficView): boolean {
  const bounds = run.bounds;
  if (!bounds) return true;
  return !(
    bounds[2] < view.west ||
    bounds[0] > view.east ||
    bounds[3] < view.south ||
    bounds[1] > view.north
  );
}

// rounding of the tile's t0/t1 (3 decimals) can leave a sub-millisecond gap
const TIME_EPS = 2e-3;

function prepareRun(run: TrafficRun): PreparedRun {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of run.coords) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return {
    t0: run.t0,
    t1: run.t1,
    coords: run.coords,
    times: run.times,
    bounds: [west, south, east, north],
  };
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

// the body shared by moving and parked cars lives in vehicle_body.ts: a
// low-poly car, or a long windowed box for trains

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
  // slice scheduling: each update places one slice, at most 30 times a second
  private sliceCursor = 0;
  private lastSlice = 0;
  private lastOriginKey = "";
  private needsFullUpdate = true;
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
    // vertex colors carry the car's own part colors; three multiplies them by
    // each instance's paint, so the body is tinted and the glass/wheels stay
    // dark
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
    });
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
    // the positions may have gone stale while hidden
    if (enabled) this.needsFullUpdate = true;
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
    this.mesh.count = 0;
    this.needsFullUpdate = true;
    this.sliceCursor = 0;
    this.lastSlice = 0;
    this.lastOriginKey = "";
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  // Place the vehicles for the current wall-clock phase. A full pass happens
  // when the loop set or the projection origin changes; otherwise one slice is
  // placed per update at ~30 Hz, and runs outside the visible lon/lat window are
  // culled before sampling. Nothing accumulates: every position is a pure
  // function of time.
  update(
    originMeters: [number, number],
    scaleFactor: number,
    view?: TrafficView,
  ): void {
    if (!this.enabled) return;
    if (this.vehicles.length === 0) {
      this.mesh.count = 0;
      return;
    }
    const now = this.now();
    const nowMs = now * 1000;
    const originKey = `${originMeters[0].toFixed(3)}:${originMeters[1].toFixed(3)}:${scaleFactor.toFixed(6)}`;
    let start = 0;
    let end = this.vehicles.length;
    const full = this.needsFullUpdate || originKey !== this.lastOriginKey;
    if (full) {
      this.needsFullUpdate = false;
      this.lastOriginKey = originKey;
      this.sliceCursor = 0;
      this.lastSlice = nowMs;
    } else {
      if (nowMs - this.lastSlice < SLICE_MS) return;
      this.lastSlice = nowMs;
      const sliceSize = Math.ceil(this.vehicles.length / SLICES);
      start = this.sliceCursor * sliceSize;
      end = Math.min(this.vehicles.length, start + sliceSize);
      this.sliceCursor = (this.sliceCursor + 1) % SLICES;
      if (start >= this.vehicles.length) {
        start = 0;
        end = Math.min(this.vehicles.length, sliceSize);
        this.sliceCursor = 1 % SLICES;
      }
    }

    const cull = view ? paddedView(view) : undefined;
    for (let i = start; i < end; i++) {
      const vehicle = this.vehicles[i];
      const period = vehicle.period;
      let tau = (now + vehicle.phase * period) % period;
      if (tau < 0) tau += period;
      // the cosmetic speed bump through crossings shifts which point of the
      // loop is drawn, but returns to zero, so the schedule is untouched
      let drawn = tau + crossingShift(tau, vehicle.crossings, now);
      drawn = ((drawn % period) + period) % period;
      const run = findRun(vehicle.runs, drawn);
      if (!run || (cull && !runInView(run, cull))) {
        // unloaded tile or outside the view: keep the slot, hide the instance
        this.mesh.setMatrixAt(i, this.hidden);
        continue;
      }
      const seconds = drawn - run.t0;
      const { lon, lat, heading } = sampleRun(run, seconds);
      const m = toModelCoords([lon, lat], originMeters, scaleFactor);
      this.dummy.position.set(m[0], m[1], this.config.height / 2);
      this.dummy.rotation.set(0, 0, heading);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.count = this.vehicles.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
