import * as THREE from "three";

import {
  toModelCoords,
  type TrafficLoop,
  type TrafficRun,
} from "./geojson_data";
import {
  compactSlots,
  crossingShift,
  crossingsAlongLoop,
  coordKey,
  paddedView,
  runInView,
  type PreparedCrossing,
  type PreparedRun,
  type TrafficView,
} from "./traffic_math";
import {
  simpleVehicleGeometry,
  vehicleGeometry,
  type VehicleBodySize,
} from "./vehicle_body";

export type { TrafficView } from "./traffic_math";

export { simpleVehicleGeometry, vehicleGeometry };

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

// GTFS buses and trams share the long windowed body but keep their own size and
// capacity; the route color comes from the loop's vehicles.
export const BUS_TRAFFIC: TrafficFleetConfig = {
  length: 11,
  width: 2.5,
  height: 3,
  body: "train",
  maxVehicles: 3000,
};

export const TRAM_TRAFFIC: TrafficFleetConfig = {
  length: 23,
  width: 2.4,
  height: 3.2,
  body: "train",
  maxVehicles: 900,
};

interface PreparedVehicle {
  loopId: string;
  phase: number;
  period: number;
  color: number;
  // body length in meters, from the loop's city override or the fleet default
  length: number;
  // shared by every vehicle on the loop, so the geometry is prepared once
  runs: PreparedRun[];
  // shared too: the loop's crossings, matched from the tile's point features
  crossings: PreparedCrossing[];
  // GTFS line/route/headsign for the click popup; cars and trains have none
  meta?: TrafficLoop["meta"];
}

// vehicles update at ~30 Hz. Two slices are placed per cycle, one per update,
// so the work is spread over frames instead of a spike every other one.
const UPDATE_HZ = 30;
const SLICES = 2;
const SLICE_MS = 1000 / UPDATE_HZ / SLICES;
// How often the visible set is recomputed. Culling depends on where each
// vehicle is on its loop, so a static map still needs a periodic remap for
// vehicles whose loop re-enters the view; half a second keeps the pop-in below
// the padding margin without scanning the whole fleet every slice. A remap
// rewrites only the visible instances, so it stays cheap.
const REMAP_MS = 500;
// A moving map changes the view every frame, but remapping the whole fleet at
// frame rate is wasteful: the 8% padding hides the lag between two remaps, so
// cap it at ~10 Hz while panning or zooming.
const PAN_REMAP_MS = 100;

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
  // equirectangular projection is enough. A dwell keyframe repeats the same
  // coordinate, so borrow the heading of the nearest moving segment.
  let heading = 0;
  let moved = false;
  for (let j = i; j < run.coords.length; j++) {
    const from = run.coords[j - 1];
    const to = run.coords[j];
    if (from[0] !== to[0] || from[1] !== to[1]) {
      const cosLat = Math.cos((to[1] * Math.PI) / 180);
      heading = Math.atan2(
        (to[1] - from[1]) * 110540,
        (to[0] - from[0]) * cosLat * 111320,
      );
      moved = true;
      break;
    }
  }
  if (!moved) {
    for (let j = i - 1; j >= 1; j--) {
      const from = run.coords[j - 1];
      const to = run.coords[j];
      if (from[0] !== to[0] || from[1] !== to[1]) {
        const cosLat = Math.cos((to[1] * Math.PI) / 180);
        heading = Math.atan2(
          (to[1] - from[1]) * 110540,
          (to[0] - from[0]) * cosLat * 111320,
        );
        break;
      }
    }
  }
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
  private readonly tint = new THREE.Color();
  private readonly capacity: number;
  private readonly now: () => number;
  private vehicles: PreparedVehicle[] = [];
  // The compacted instance buffer: `slots[0..visibleCount)` maps a draw slot
  // back to its vehicle. Rebuilt in place on a remap so nothing allocates per
  // frame.
  private slots = new Int32Array(0);
  private visibleCount = 0;
  // slice scheduling: each update places one slice, at most 30 times a second
  private sliceCursor = 0;
  private lastSlice = 0;
  private lastRemap = 0;
  private lastOriginKey = "";
  private lastViewKey = "";
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

  // the clock used for the current positions; the camera follow reads the
  // same clock so it tracks the drawn instance
  get currentTime(): number {
    return this.now();
  }

  // live vehicle count, for the perf benchmark
  get count(): number {
    return this.vehicles.length;
  }

  // instances actually drawn after compaction
  get drawnCount(): number {
    return this.visibleCount;
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
        id: string;
        period: number;
        runs: PreparedRun[];
        vehicles: TrafficLoop["vehicles"];
        vehicleLength?: number;
        meta?: TrafficLoop["meta"];
      }
    >();
    for (const loop of loops) {
      let group = byId.get(loop.id);
      if (!group) {
        group = {
          id: loop.id,
          period: loop.period,
          runs: [],
          vehicles: loop.vehicles,
          vehicleLength: loop.vehicleLength,
          meta: loop.meta,
        };
        byId.set(loop.id, group);
      }
      for (const run of loop.runs) group.runs.push(prepareRun(run));
    }

    const vehicles: PreparedVehicle[] = [];
    for (const group of byId.values()) {
      if (vehicles.length >= this.capacity) break;
      group.runs.sort((a, b) => a.t0 - b.t0);
      const crossings = crossingsAlongLoop(group.runs, keys);
      for (const vehicle of group.vehicles) {
        if (vehicles.length >= this.capacity) break;
        vehicles.push({
          loopId: group.id,
          phase: vehicle.phase,
          period: group.period,
          color: vehicle.color,
          length: group.vehicleLength ?? this.config.length,
          runs: group.runs,
          crossings,
          meta: group.meta,
        });
      }
    }
    if (vehicles.length >= this.capacity) {
      console.warn("traffic: vehicle capacity exceeded, dropping routes");
    }
    this.vehicles = vehicles;
    // the slot buffer follows the vehicle list; a remap fills it
    this.slots = new Int32Array(vehicles.length);
    this.visibleCount = 0;
    this.mesh.count = 0;
    this.needsFullUpdate = true;
    this.sliceCursor = 0;
    this.lastSlice = 0;
    this.lastRemap = 0;
    this.lastOriginKey = "";
    this.lastViewKey = "";
  }

  // Return the visible vehicle under a ray, if any. Only the compacted slots
  // are drawn, so the instance id is the slot; `slots` maps it back to the
  // vehicle and therefore to its GTFS metadata, when the fleet has any. Cars
  // have no metadata, so the caller falls back to a plain "Car" popup.
  pick(raycaster: THREE.Raycaster):
    | {
        meta: TrafficLoop["meta"];
        point: THREE.Vector3;
        distance: number;
        loopId: string;
        phase: number;
      }
    | undefined {
    if (!this.enabled || this.visibleCount === 0) return undefined;
    // the instance matrices move every frame; a stale bounding sphere from
    // before the first placement would make the ray reject the whole mesh
    this.mesh.computeBoundingSphere();
    for (const hit of raycaster.intersectObject(this.mesh, false)) {
      const slot = hit.instanceId;
      if (slot === undefined || slot >= this.visibleCount) continue;
      const vehicle = this.vehicles[this.slots[slot]];
      return {
        meta: vehicle.meta,
        point: hit.point,
        distance: hit.distance,
        loopId: vehicle.loopId,
        phase: vehicle.phase,
      };
    }
    return undefined;
  }

  // Current lon/lat and heading of one vehicle, for camera following. Uses the
  // same phase/crossing shift as the rendered instance, so the camera tracks
  // what is on screen rather than a nearby but different point.
  positionAt(
    loopId: string,
    phase: number,
    now: number,
  ): { lon: number; lat: number; heading: number } | undefined {
    const vehicle = this.vehicles.find(
      (candidate) => candidate.loopId === loopId && candidate.phase === phase,
    );
    if (!vehicle) return undefined;
    let tau = (now + vehicle.phase * vehicle.period) % vehicle.period;
    if (tau < 0) tau += vehicle.period;
    const drawn =
      (tau + crossingShift(tau, vehicle.crossings, now)) % vehicle.period;
    const run = findRun(vehicle.runs, drawn);
    if (!run) return undefined;
    return sampleRun(run, drawn - run.t0);
  }

  // Place the vehicles for the current wall-clock phase. The visible set is
  // remapped when the view, origin or loop set changes, and periodically so a
  // vehicle whose loop re-enters a static view is not lost. A remap writes every
  // visible instance once; otherwise one slice of the compacted buffer is placed
  // per update at ~30 Hz. Nothing accumulates: every position is a pure function
  // of time.
  update(
    originMeters: [number, number],
    scaleFactor: number,
    view?: TrafficView,
  ): void {
    if (!this.enabled) return;
    if (this.vehicles.length === 0) {
      this.visibleCount = 0;
      this.mesh.count = 0;
      return;
    }
    const now = this.now();
    const nowMs = now * 1000;
    const originKey = `${originMeters[0].toFixed(3)}:${originMeters[1].toFixed(3)}:${scaleFactor.toFixed(6)}`;
    const viewKey = view
      ? `${view.west.toFixed(5)}:${view.south.toFixed(5)}:${view.east.toFixed(5)}:${view.north.toFixed(5)}`
      : "";
    // A moving map changes the view key every frame, which is exactly when the
    // visible set must follow it; a static one still remaps every REMAP_MS.
    const viewMoved =
      originKey !== this.lastOriginKey || viewKey !== this.lastViewKey;
    const remap =
      this.needsFullUpdate ||
      (viewMoved && nowMs - this.lastRemap >= PAN_REMAP_MS) ||
      nowMs - this.lastRemap >= REMAP_MS;
    if (remap) {
      this.needsFullUpdate = false;
      this.lastOriginKey = originKey;
      this.lastViewKey = viewKey;
      this.lastRemap = nowMs;
      this.lastSlice = nowMs;
      this.sliceCursor = 0;
      this.remap(now, originMeters, scaleFactor, view);
      return;
    }
    if (nowMs - this.lastSlice < SLICE_MS) return;
    this.lastSlice = nowMs;
    const count = this.visibleCount;
    const sliceSize = Math.ceil(count / SLICES);
    let start = this.sliceCursor * sliceSize;
    let end = Math.min(count, start + sliceSize);
    this.sliceCursor = (this.sliceCursor + 1) % SLICES;
    if (start >= count) {
      start = 0;
      end = Math.min(count, sliceSize);
      this.sliceCursor = 1 % SLICES;
    }
    const cull = view ? paddedView(view) : undefined;
    for (let slot = start; slot < end; slot++) {
      this.place(this.slots[slot], slot, now, originMeters, scaleFactor, cull);
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // Rebuild the vehicle -> slot map for the current view and write every visible
  // instance once. Slots above the new count are not drawn, so a shrinking
  // visible set never leaves a ghost behind; every slot below it is freshly
  // written here.
  private remap(
    now: number,
    originMeters: [number, number],
    scaleFactor: number,
    view?: TrafficView,
  ): void {
    const cull = view ? paddedView(view) : undefined;
    // Visibility tests the unshifted loop-time: the crossing bump shifts the
    // drawn point by a couple of seconds at most, so a vehicle can only be
    // misclassified within one bump width of an edge, and the next remap
    // corrects it. Running crossingShift over the whole fleet on every remap
    // would cost more than the handful of instances it saves.
    const count = compactSlots(
      this.vehicles.length,
      (i) => {
        const vehicle = this.vehicles[i];
        let tau = (now + vehicle.phase * vehicle.period) % vehicle.period;
        if (tau < 0) tau += vehicle.period;
        const run = findRun(vehicle.runs, tau);
        return run !== undefined && (!cull || runInView(run, cull));
      },
      this.slots,
    );
    this.visibleCount = count;
    for (let slot = 0; slot < count; slot++) {
      const vehicle = this.vehicles[this.slots[slot]];
      // colors follow the compacted slot, so they are rewritten on every remap
      // instead of once per vehicle in setLoops
      this.mesh.setColorAt(slot, this.tint.set(vehicle.color));
      this.place(this.slots[slot], slot, now, originMeters, scaleFactor, cull);
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  // Sample one vehicle's current point and write it into `slot`. A culled or
  // unloaded run hides the instance: a stale matrix below the count would read
  // as a ghost at the old position.
  private place(
    vehicleIndex: number,
    slot: number,
    now: number,
    originMeters: [number, number],
    scaleFactor: number,
    cull?: TrafficView,
  ): void {
    const vehicle = this.vehicles[vehicleIndex];
    const period = vehicle.period;
    let tau = (now + vehicle.phase * period) % period;
    if (tau < 0) tau += period;
    // the cosmetic speed bump through crossings shifts which point of the
    // loop is drawn, but returns to zero, so the schedule is untouched
    let drawn = tau + crossingShift(tau, vehicle.crossings, now);
    drawn = ((drawn % period) + period) % period;
    const run = findRun(vehicle.runs, drawn);
    if (!run || (cull && !runInView(run, cull))) {
      this.mesh.setMatrixAt(slot, this.hidden);
      return;
    }
    const seconds = drawn - run.t0;
    const { lon, lat, heading } = sampleRun(run, seconds);
    const m = toModelCoords([lon, lat], originMeters, scaleFactor);
    this.dummy.position.set(m[0], m[1], this.config.height / 2);
    this.dummy.rotation.set(0, 0, heading);
    // the body is built at the fleet length; a line override only stretches X
    this.dummy.scale.set(vehicle.length / this.config.length, 1, 1);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(slot, this.dummy.matrix);
  }
}
