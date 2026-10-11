import * as THREE from "three";

import { toModelCoords, type Road } from "./geojson_data";

const CAR_LENGTH = 4;
const CAR_WIDTH = 2;
const CAR_HEIGHT = 1.5;
const MIN_SPACING = 60; // meters between cars spawned on one road
const MAX_VEHICLES = 500;
const SPEED_MIN = 6; // m/s
const SPEED_MAX = 16;

const CAR_COLORS = [
  0xff5555, 0x5555ff, 0xffffff, 0x222222, 0xffcc33, 0x33cc99, 0xcccccc,
  0x99bbff,
];

interface Vehicle {
  roadId: string;
  s: number; // meters along the road
  dir: 1 | -1;
  speed: number;
  color: THREE.Color;
}

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

// a road preprocessed for fast placement: cumulative metrage plus a point
// lookup, so the per-frame update avoids calling into turf for every vehicle
class RoadPath {
  readonly pts: [number, number][];
  private readonly cum: number[];
  readonly length: number;

  constructor(coordinates: [number, number][]) {
    this.pts = coordinates;
    this.cum = [0];
    for (let i = 1; i < coordinates.length; i++) {
      this.cum.push(
        this.cum[i - 1] + metersBetween(coordinates[i - 1], coordinates[i]),
      );
    }
    this.length = this.cum[this.cum.length - 1];
  }

  pointAt(s: number): [number, number] {
    const clamped = Math.max(0, Math.min(this.length, s));
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i] < clamped) i++;
    const c0 = this.cum[i - 1];
    const c1 = this.cum[i];
    const t = c1 > c0 ? (clamped - c0) / (c1 - c0) : 0;
    const a = this.pts[i - 1];
    const b = this.pts[i];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
}

export class VehicleManager {
  private readonly mesh: THREE.InstancedMesh;
  private readonly paths = new Map<string, RoadPath>();
  private vehicles: Vehicle[] = [];
  private readonly dummy = new THREE.Object3D();
  private readonly clock = new THREE.Clock();

  constructor(scene: THREE.Scene) {
    const geometry = new THREE.BoxGeometry(CAR_LENGTH, CAR_WIDTH, CAR_HEIGHT);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_VEHICLES);
    this.mesh.count = 0;
    // instances move every frame, so frustum culling against the initial
    // (empty) bounds would hide them
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  // reconcile the fleet with the currently loaded roads. Cars whose road is
  // still present are kept (so they don't teleport when tiles load/unload).
  setRoads(roads: Road[]): void {
    const present = new Set<string>();
    for (const road of roads) {
      if (road.coordinates.length < 2) continue;
      present.add(road.id);
      if (!this.paths.has(road.id)) {
        const path = new RoadPath(road.coordinates);
        if (path.length > 2) this.paths.set(road.id, path);
      }
    }
    for (const id of [...this.paths.keys()]) {
      if (!present.has(id)) this.paths.delete(id);
    }
    this.vehicles = this.vehicles.filter((v) => this.paths.has(v.roadId));

    const occupied = new Set(this.vehicles.map((v) => v.roadId));
    for (const [id, path] of this.paths) {
      if (this.vehicles.length >= MAX_VEHICLES) break;
      if (occupied.has(id)) continue;
      const n = Math.min(
        Math.max(1, Math.floor(path.length / MIN_SPACING)),
        MAX_VEHICLES - this.vehicles.length,
      );
      for (let i = 0; i < n; i++) {
        this.vehicles.push({
          roadId: id,
          s: ((i + Math.random()) / n) * path.length,
          dir: Math.random() < 0.5 ? 1 : -1,
          speed: SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN),
          color: new THREE.Color(
            CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0],
          ),
        });
      }
    }
  }

  // advance the fleet and write instance transforms. Positions are recomputed
  // in model space from the current origin every frame, so a projection-origin
  // reset needs no special handling here (unlike the tile meshes).
  update(originMeters: [number, number], scaleFactor: number): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    let count = 0;
    for (const v of this.vehicles) {
      const path = this.paths.get(v.roadId);
      if (!path) continue;
      v.s += v.dir * v.speed * dt;
      // ping-pong at the ends of the road
      if (v.s > path.length) {
        v.s = 2 * path.length - v.s;
        v.dir = -1;
      } else if (v.s < 0) {
        v.s = -v.s;
        v.dir = 1;
      }
      const here = path.pointAt(v.s);
      const before = path.pointAt(v.s - 1);
      const ahead = path.pointAt(v.s + 1);
      const m = toModelCoords(here, originMeters, scaleFactor);
      const ma = toModelCoords(before, originMeters, scaleFactor);
      const mb = toModelCoords(ahead, originMeters, scaleFactor);
      const angle = Math.atan2(mb[1] - ma[1], mb[0] - ma[0]);
      this.dummy.position.set(m[0], m[1], CAR_HEIGHT / 2);
      this.dummy.rotation.set(0, 0, angle);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(count, this.dummy.matrix);
      this.mesh.setColorAt(count, v.color);
      count++;
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
