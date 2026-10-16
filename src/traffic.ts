import * as THREE from "three";

import { toModelCoords, type TrafficLoop } from "./geojson_data";

// a fleet of vehicles simulated along precomputed routes
export interface TrafficFleetConfig {
  length: number; // vehicle box size, meters
  width: number;
  height: number;
  maxVehicles: number;
  accel: number; // m/s^2
  decel: number;
}

export const CAR_TRAFFIC: TrafficFleetConfig = {
  length: 8 / 3,
  width: 4 / 3,
  height: 1,
  maxVehicles: 40000,
  accel: 8,
  decel: 10,
};

// trains/trams: longer and slimmer than a car
export const TRAIN_TRAFFIC: TrafficFleetConfig = {
  length: 15,
  width: 1.5,
  height: 2,
  maxVehicles: 500,
  accel: 3,
  decel: 4,
};

// a 16 s signal cycle, 8 s green per axis: axis 0 green in [0, 8), axis 1 in
// [8, 16). Every vehicle reads the same clock, so a crossing is coherent.
const CYCLE = 16;
const HALF = CYCLE / 2;
// vehicles always creep this fast so they actually reach a stop
const MIN_CREEP = 1.5;
// how close to a red light a vehicle starts to brake
const LOOKAHEAD = 40;

interface SimLoop {
  coords: [number, number][];
  cum: number[];
  speeds: number[];
  length: number;
  // crossings sorted by arc, with the approach axis (0 or 1)
  crossings: { arc: number; group: number }[];
  cars: SimCar[];
}

interface SimCar {
  arc: number;
  velocity: number;
  color: THREE.Color;
}

// index of the segment containing `arc` (cum is ascending)
function segmentOf(cum: number[], arc: number): number {
  let lo = 1;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < arc) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function pointAt(
  loop: SimLoop,
  arc: number,
): { lon: number; lat: number; heading: number } {
  const i = segmentOf(loop.cum, arc);
  const c0 = loop.cum[i - 1];
  const c1 = loop.cum[i];
  const f = c1 > c0 ? (arc - c0) / (c1 - c0) : 0;
  const a = loop.coords[i - 1];
  const b = loop.coords[i];
  const lon = a[0] + (b[0] - a[0]) * f;
  const lat = a[1] + (b[1] - a[1]) * f;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const heading = Math.atan2(
    (b[1] - a[1]) * 110540,
    (b[0] - a[0]) * cosLat * 111320,
  );
  return { lon, lat, heading };
}

/**
 * Simulates vehicles along precomputed routes (loop geometry + per-segment
 * speeds + crossings). Vehicles obey a shared 16 s signal cycle and follow the
 * vehicle ahead, so they queue at red lights and never overlap; the routes
 * themselves are deterministic data, only the motion is simulated.
 */
export class TrafficRenderer {
  private readonly mesh: THREE.InstancedMesh;
  private readonly config: TrafficFleetConfig;
  private readonly scene: THREE.Scene;
  private readonly dummy = new THREE.Object3D();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly timer = new THREE.Timer();
  private loops: SimLoop[] = [];
  // debug (?debug=lights): crossings, as lon/lat
  private readonly debug: boolean;
  private crossings: [number, number][] = [];
  private points?: THREE.Points;
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
    this.timer.connect(document);
    if (debug) {
      this.points = new THREE.Points(
        new THREE.BufferGeometry(),
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
    return this.loops.reduce((n, loop) => n + loop.cars.length, 0);
  }

  // one copy of each loop (it appears in every tile it touches)
  setLoops(loops: TrafficLoop[]): void {
    const byId = new Map<string, TrafficLoop>();
    for (const loop of loops) if (!byId.has(loop.id)) byId.set(loop.id, loop);

    const simLoops: SimLoop[] = [];
    const crossings: [number, number][] = [];
    let slot = 0;
    for (const loop of byId.values()) {
      const cum = loop.cum;
      const length = cum[cum.length - 1];
      if (!(length > 0)) continue;
      const cars: SimCar[] = [];
      for (const vehicle of loop.vehicles) {
        if (slot >= this.capacity) break;
        const arc = vehicle.phase * length;
        this.mesh.setColorAt(slot, new THREE.Color(vehicle.color));
        cars.push({
          arc,
          velocity: loop.speeds[segmentOf(cum, arc)],
          color: new THREE.Color(vehicle.color),
        });
        slot++;
      }
      if (cars.length === 0) continue;
      const simLoop: SimLoop = {
        coords: loop.coords,
        cum,
        speeds: loop.speeds,
        length,
        crossings: loop.crossings.map(([arc, group]) => ({ arc, group })),
        cars,
      };
      simLoops.push(simLoop);
      if (this.debug) {
        for (const crossing of simLoop.crossings) {
          const point = pointAt(simLoop, crossing.arc);
          crossings.push([point.lon, point.lat]);
        }
      }
    }
    this.loops = simLoops;
    this.crossings = crossings;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(originMeters: [number, number], scaleFactor: number): void {
    if (!this.enabled) return;
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const now = this.now();
    // both axes agree on the light because everyone reads this clock
    const greenGroup = Math.floor((now % CYCLE) / HALF) % 2;

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
    for (const loop of this.loops) {
      loop.cars.sort((a, b) => a.arc - b.arc);
      for (let i = 0; i < loop.cars.length; i++) {
        const car = loop.cars[i];
        const segment = segmentOf(loop.cum, car.arc);
        let desired = loop.speeds[segment];

        // next crossing ahead (wrapping the loop)
        let nearest = Infinity;
        let nearestGroup = 0;
        for (const crossing of loop.crossings) {
          const ahead = (crossing.arc - car.arc + loop.length) % loop.length;
          if (ahead < nearest) {
            nearest = ahead;
            nearestGroup = crossing.group;
          }
        }
        if (nearest < LOOKAHEAD && nearestGroup !== greenGroup) {
          // red for this approach: brake to the crossing
          desired = Math.min(
            desired,
            Math.max(MIN_CREEP, Math.sqrt(2 * this.config.decel * nearest)),
          );
        }

        // follow the car ahead (the next one by arc, wrapping for the last)
        const leader = loop.cars[(i + 1) % loop.cars.length];
        if (leader !== car) {
          const gap = (leader.arc - car.arc + loop.length) % loop.length;
          const effective = gap - this.config.length - 1;
          desired = Math.min(
            desired,
            effective <= 0 ? 0 : Math.sqrt(2 * this.config.decel * effective),
          );
        }

        if (car.velocity < desired) {
          car.velocity = Math.min(
            desired,
            car.velocity + this.config.accel * dt,
          );
        } else {
          car.velocity = Math.max(
            desired,
            car.velocity - this.config.decel * dt,
          );
        }
        car.arc = (car.arc + car.velocity * dt) % loop.length;

        const { lon, lat, heading } = pointAt(loop, car.arc);
        const m = toModelCoords([lon, lat], originMeters, scaleFactor);
        this.dummy.position.set(m[0], m[1], this.config.height / 2);
        this.dummy.rotation.set(0, 0, heading);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(count, this.dummy.matrix);
        count++;
      }
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
