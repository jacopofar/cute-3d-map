import * as THREE from "three";

import { toModelCoords, type TrafficLoop } from "./geojson_data";

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

// a run with its time keyframes; speed may vary along it
interface PreparedRun {
  t0: number;
  t1: number;
  coords: [number, number][];
  times: number[];
}

// a standstill: the car sits from `start` to `end`; `lon`/`lat`/`heading` are
// set only when the stop lands in a loaded tile, else it is off-screen
interface Stop {
  start: number;
  end: number;
  cum: number; // total wait through this stop
  lon: number;
  lat: number;
  heading: number;
  onScreen: boolean;
}

interface PreparedVehicle {
  phase: number;
  period: number;
  runs: PreparedRun[];
  stops: Stop[];
  // wait accrued before the earliest loaded run (stops off-screen)
  baseCarry: number;
  color: THREE.Color;
}

// rounding of the tile's t0/t1 (3 decimals) can leave a sub-millisecond gap
const TIME_EPS = 2e-3;

// ?debug=lights tints vehicles that are standing at a light
const DEBUG_HOLD = new THREE.Color(0xff2020);

// the stop that contains `tau`, if any
function findStop(stops: Stop[], tau: number): Stop | undefined {
  let lo = 0;
  let hi = stops.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (stops[mid].start <= tau) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return undefined;
  return tau < stops[best].end ? stops[best] : undefined;
}

// total wait already spent before `tau`
function waitsBefore(stops: Stop[], tau: number): number {
  let lo = 0;
  let hi = stops.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (stops[mid].end <= tau) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best >= 0 ? stops[best].cum : 0;
}

// the run whose [t0, t1) contains tau (base time), or undefined when the
// vehicle is in a part of the loop whose tile is not loaded. Sorted by t0.
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

// point (lon/lat) and heading at `seconds` (a schedule time; the run's `times`
// are absolute, from the loop start). The run's speed is constant between two
// keyframes, so interpolating them by time is exact.
function sampleRun(
  run: PreparedRun,
  seconds: number,
): { lon: number; lat: number; heading: number } {
  const first = run.times[0];
  const total = run.times[run.times.length - 1];
  const d = Math.max(first, Math.min(total, seconds));
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

/**
 * Renders precomputed traffic: every vehicle is a pure function of wall-clock
 * time, so there is no simulation to advance, nothing to rebuild when a tile
 * arrives and no state to lose when one leaves. Tile load/unload only changes
 * which loops are present (setLoops).
 */
export class TrafficRenderer {
  private readonly scene: THREE.Scene;
  private readonly mesh: THREE.InstancedMesh;
  private readonly config: TrafficFleetConfig;
  private readonly debug: boolean;
  private readonly dummy = new THREE.Object3D();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly capacity: number;
  private readonly now: () => number;
  private vehicles: PreparedVehicle[] = [];
  // debug (?debug=lights): the crossings the loaded cars obey, as lon/lat
  private crossings: [number, number][] = [];
  private points?: THREE.Points;
  // when disabled (map zoomed out) the mesh is hidden and the per-frame update
  // is skipped
  enabled = true;

  constructor(
    scene: THREE.Scene,
    config: TrafficFleetConfig,
    now: () => number = () => Date.now() / 1000,
    debug = false,
  ) {
    this.scene = scene;
    this.config = config;
    this.now = now;
    this.debug = debug;
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
    if (debug) {
      const pointGeometry = new THREE.BufferGeometry();
      this.points = new THREE.Points(
        pointGeometry,
        new THREE.PointsMaterial({
          color: 0xff00ff,
          size: 6,
          sizeAttenuation: false,
        }),
      );
      this.points.frustumCulled = false;
      scene.add(this.points);
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.mesh.visible = enabled;
  }

  // live vehicle count, for the perf benchmark
  get count(): number {
    return this.vehicles.length;
  }

  // the union of the loaded tiles' traffic. A loop appears in every tile it
  // spans; the renderer merges those pieces by loop id, and within a loop each
  // vehicle gets its own runs (its own keyframe times), sharing the coords.
  setLoops(loops: TrafficLoop[]): void {
    const byId = new Map<string, { period: number; entries: TrafficLoop[] }>();
    for (const loop of loops) {
      let group = byId.get(loop.id);
      if (!group) {
        group = { period: loop.period, entries: [] };
        byId.set(loop.id, group);
      }
      group.entries.push(loop);
    }

    const vehicles: PreparedVehicle[] = [];
    let slot = 0;
    for (const group of byId.values()) {
      const source = group.entries[0].vehicles;
      if (slot >= this.capacity) break;
      for (let index = 0; index < source.length; index++) {
        if (slot >= this.capacity) break;
        const runs: PreparedRun[] = [];
        const stops: Stop[] = [];
        // the wait already accrued before the earliest loaded run
        let baseCarry = 0;
        let earliest = Infinity;
        for (const entry of group.entries) {
          const schedule = entry.vehicles[index].runs;
          for (let r = 0; r < entry.runs.length; r++) {
            const coords = entry.runs[r].coords;
            const times = entry.runs[r].times;
            const run: PreparedRun = {
              coords,
              times,
              t0: times[0],
              t1: times[times.length - 1],
            };
            runs.push(run);
            const { carry, events } = schedule[r];
            if (times[0] < earliest) {
              earliest = times[0];
              baseCarry = carry;
            }
            let cum = carry;
            for (const [base, wait] of events) {
              const at = sampleRun(run, base);
              stops.push({
                start: base + cum,
                end: base + cum + wait,
                cum: cum + wait,
                lon: at.lon,
                lat: at.lat,
                heading: at.heading,
                onScreen: true,
              });
              cum += wait;
            }
          }
        }
        runs.sort((a, b) => a.t0 - b.t0);
        stops.sort((a, b) => a.start - b.start);
        this.mesh.setColorAt(slot, new THREE.Color(source[index].color));
        vehicles.push({
          phase: source[index].phase,
          period: source[index].period,
          runs,
          stops,
          baseCarry,
          color: new THREE.Color(source[index].color),
        });
        slot++;
      }
    }
    if (this.debug) {
      const seen = new Set<string>();
      const crossings: [number, number][] = [];
      for (const vehicle of vehicles) {
        for (const stop of vehicle.stops) {
          if (!stop.onScreen) continue;
          const key = `${stop.lon.toFixed(5)},${stop.lat.toFixed(5)}`;
          if (!seen.has(key)) {
            seen.add(key);
            crossings.push([stop.lon, stop.lat]);
          }
        }
      }
      this.crossings = crossings;
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
    if (this.debug && this.points) {
      const positions = new Float32Array(this.crossings.length * 3);
      for (let i = 0; i < this.crossings.length; i++) {
        const m = toModelCoords(this.crossings[i], originMeters, scaleFactor);
        positions[i * 3] = m[0];
        positions[i * 3 + 1] = m[1];
        positions[i * 3 + 2] = 8;
      }
      this.points.geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(positions, 3),
      );
    }
    let count = 0;
    let colorChanged = false;
    for (const vehicle of this.vehicles) {
      const period = vehicle.period;
      let tau = (now + vehicle.phase * period) % period;
      if (tau < 0) tau += period;
      const stop = findStop(vehicle.stops, tau);
      let lon: number;
      let lat: number;
      let heading: number;
      if (stop) {
        // standing at a red light; if that stop is in an unloaded tile, hide it
        if (!stop.onScreen) {
          this.mesh.setMatrixAt(count, this.hidden);
          count++;
          continue;
        }
        lon = stop.lon;
        lat = stop.lat;
        heading = stop.heading;
      } else {
        const base =
          tau - Math.max(vehicle.baseCarry, waitsBefore(vehicle.stops, tau));
        const run = findRun(vehicle.runs, base);
        if (!run) {
          // the tile holding this part of the loop is not loaded: hide the
          // vehicle with a zero-scale matrix but keep its slot for the color
          this.mesh.setMatrixAt(count, this.hidden);
          count++;
          continue;
        }
        ({ lon, lat, heading } = sampleRun(run, base));
      }
      if (this.debug) {
        // tint whoever is standing at a light
        this.mesh.setColorAt(count, stop ? DEBUG_HOLD : vehicle.color);
        colorChanged = true;
      }
      const m = toModelCoords([lon, lat], originMeters, scaleFactor);
      this.dummy.position.set(m[0], m[1], this.config.height / 2);
      this.dummy.rotation.set(0, 0, heading);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(count, this.dummy.matrix);
      count++;
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (colorChanged && this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
    }
  }
}
