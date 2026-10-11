import * as THREE from "three";

import { toModelCoords, type Road } from "./geojson_data";

// tuning for one fleet (cars on roads, trains on rails, ...)
export interface FleetConfig {
  length: number; // vehicle box size, meters
  width: number;
  height: number;
  minSpacing: number; // meters between vehicles along a cycle
  maxVehicles: number;
  speedMin: number; // m/s
  speedMax: number;
  stopMin: number; // seconds paused when arriving at a crossing
  stopMax: number;
  greyFraction: number; // fraction of vehicles using a grey shade
  greyColors: number[];
  colors: number[];
  minCycleCrossings: number; // a cycle must pass through this many crossings...
  maxCycleCrossings: number;
  minCycleLength: number; // ...and be at least this long
  minEdgeLength: number; // ignore degenerate edges (meters)
}

export const CAR_FLEET: FleetConfig = {
  length: 8 / 3,
  width: 4 / 3,
  height: 1,
  minSpacing: 12.5,
  maxVehicles: 4000,
  speedMin: 6,
  speedMax: 16,
  stopMin: 0.2,
  stopMax: 0.75,
  greyFraction: 0.6,
  greyColors: [0xe0e0e0, 0xb0b0b0, 0x888888, 0x555555, 0x333333, 0xa8a8a8],
  colors: [0xff5555, 0x5555ff, 0xffcc33, 0x33cc99],
  minCycleCrossings: 3,
  maxCycleCrossings: 10,
  minCycleLength: 50,
  minEdgeLength: 1,
};

// trains/trams: half the size and frequency of before, dark orange, and they
// stop at junctions for longer than cars
export const TRAIN_FLEET: FleetConfig = {
  length: 15,
  width: 1.5,
  height: 2,
  minSpacing: 800,
  maxVehicles: 100,
  speedMin: 8,
  speedMax: 20,
  stopMin: 0.8,
  stopMax: 3,
  greyFraction: 0,
  greyColors: [],
  colors: [0xff8c00],
  minCycleCrossings: 3,
  maxCycleCrossings: 10,
  minCycleLength: 50,
  minEdgeLength: 1,
};

// one road/rail segment between two graph nodes
interface Edge {
  key: string;
  a: string; // node key at pts[0]
  b: string; // node key at pts[last]
  pts: [number, number][];
  cum: number[]; // cumulative meters from `a`
  length: number;
  stops: number[]; // distances (meters from `a`) where vehicles pause, sorted
}

// one edge of a cycle, plus whether the node it arrives at is a crossing
interface Step {
  edgeKey: string;
  dir: 1 | -1; // +1 travels a -> b, -1 travels b -> a
  stop: boolean;
}

interface Cycle {
  id: string;
  steps: Step[];
  length: number;
}

interface Vehicle {
  id: string; // stable `${cycleId}#${slot}`
  cycleId: string;
  step: number; // index into the cycle's steps
  s: number; // meters travelled along the current step
  speed: number;
  waitUntil: number; // ms timestamp: while in the future the vehicle is stopped
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

// a node id shared by ways meeting at the same point. Coordinates are rounded
// so tile-clipped endpoints on a shared boundary collide exactly.
function coordKey(c: [number, number]): string {
  return `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
}

function pointAt(edge: Edge, distanceFromA: number): [number, number] {
  const clamped = Math.max(0, Math.min(edge.length, distanceFromA));
  let i = 1;
  while (i < edge.cum.length - 1 && edge.cum[i] < clamped) i++;
  const c0 = edge.cum[i - 1];
  const c1 = edge.cum[i];
  const t = c1 > c0 ? (clamped - c0) / (c1 - c0) : 0;
  const a = edge.pts[i - 1];
  const b = edge.pts[i];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// nearest point on the edge to `point`, in local meters; returns the distance
// and the arc-length (meters from `a`) of that point
function projectOntoEdge(
  edge: Edge,
  point: [number, number],
): { dist: number; along: number } {
  const cosLat = Math.cos((point[1] * Math.PI) / 180);
  let bestDist = Infinity;
  let bestAlong = 0;
  for (let i = 1; i < edge.pts.length; i++) {
    const a = edge.pts[i - 1];
    const b = edge.pts[i];
    const ax = (a[0] - point[0]) * cosLat * 111320;
    const ay = (a[1] - point[1]) * 110540;
    const bx = (b[0] - point[0]) * cosLat * 111320;
    const by = (b[1] - point[1]) * 110540;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const dist = Math.hypot(ax + t * dx, ay + t * dy);
    if (dist < bestDist) {
      bestDist = dist;
      bestAlong = edge.cum[i - 1] + t * (edge.cum[i] - edge.cum[i - 1]);
    }
  }
  return { dist: bestDist, along: bestAlong };
}

// the stop distance (from `a`) crossed while travelling from `from` to `to`,
// or null. `edge.stops` is sorted ascending.
function crossedStop(
  edge: Edge,
  from: number,
  to: number,
  dir: 1 | -1,
): number | null {
  if (dir === 1) {
    for (const d of edge.stops) if (d > from && d <= to) return d;
  } else {
    for (let i = edge.stops.length - 1; i >= 0; i--) {
      const d = edge.stops[i];
      if (d < from && d >= to) return d;
    }
  }
  return null;
}

export class VehicleManager {
  // The paths from every loaded tile are pulled into one graph, so a cycle can
  // run across tile boundaries. Vehicles loop their cycle (no ping-pong); at a
  // crossing they may take a different branch (different cycles), with a brief
  // stop (cars; trains have stopMin/stopMax = 0).
  private readonly mesh: THREE.InstancedMesh;
  private readonly edges = new Map<string, Edge>();
  private readonly nodes = new Map<string, string[]>(); // node -> incident edge keys
  private readonly cycles = new Map<string, Cycle>();
  private vehicles: Vehicle[] = [];
  private byId = new Map<string, Vehicle>();
  private readonly dummy = new THREE.Object3D();
  private readonly clock = new THREE.Clock();
  private readonly config: FleetConfig;
  // when disabled (map zoomed out) the mesh is hidden and the per-frame update
  // is skipped
  enabled = true;

  constructor(scene: THREE.Scene, config: FleetConfig) {
    this.config = config;
    const geometry = new THREE.BoxGeometry(
      config.length,
      config.width,
      config.height,
    );
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(
      geometry,
      material,
      config.maxVehicles,
    );
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

  setRoads(paths: Road[], stops: [number, number][] = []): void {
    if (!this.enabled) return;
    this.buildGraph(paths);
    this.snapStops(stops);
    this.findCycles();

    // Pick which vehicles to show by a stable bottom-k hash over every (cycle,
    // slot) candidate, so the fleet spreads uniformly over the whole graph
    // rather than greedily filling the cap on the first tiles that load.
    const candidates: { id: string; cycleId: string; slot: number; key: number }[] =
      [];
    for (const [cycleId, cycle] of this.cycles) {
      const n = Math.max(1, Math.floor(cycle.length / this.config.minSpacing));
      for (let i = 0; i < n; i++) {
        const id = `${cycleId}#${i}`;
        candidates.push({ id, cycleId, slot: i, key: this.hash01(id) });
      }
    }
    candidates.sort((a, b) => a.key - b.key);

    const vehicles: Vehicle[] = [];
    for (const candidate of candidates.slice(0, this.config.maxVehicles)) {
      const existing = this.byId.get(candidate.id);
      if (existing) {
        // keep the vehicle (and its progress along the cycle) across re-syncs
        vehicles.push(existing);
        continue;
      }
      const cycle = this.cycles.get(candidate.cycleId);
      if (!cycle) continue;
      const step = Math.floor(
        this.hash01(`${candidate.id}step`) * cycle.steps.length,
      );
      const edge = this.edges.get(cycle.steps[step].edgeKey);
      vehicles.push({
        id: candidate.id,
        cycleId: candidate.cycleId,
        step,
        s: this.hash01(`${candidate.id}s`) * (edge?.length ?? 0),
        speed:
          this.config.speedMin +
          this.hash01(`${candidate.id}v`) *
            (this.config.speedMax - this.config.speedMin),
        waitUntil: 0,
        color: this.vehicleColor(candidate.id),
      });
    }
    this.vehicles = vehicles;
    this.byId = new Map(vehicles.map((v) => [v.id, v]));
  }

  private buildGraph(roads: Road[]): void {
    this.edges.clear();
    this.nodes.clear();
    for (const road of roads) {
      const pts = road.coordinates;
      if (pts.length < 2) continue;
      const a = coordKey(pts[0]);
      const b = coordKey(pts[pts.length - 1]);
      if (a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (this.edges.has(key)) continue;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) {
        cum.push(cum[i - 1] + metersBetween(pts[i - 1], pts[i]));
      }
      const length = cum[cum.length - 1];
      if (length < this.config.minEdgeLength) continue;
      this.edges.set(key, { key, a, b, pts, cum, length, stops: [] });
      this.node(a).push(key);
      this.node(b).push(key);
    }
  }

  // attach each stop point to the nearest edge (within a tolerance), recording
  // the distance along that edge where vehicles should pause
  private snapStops(points: [number, number][]): void {
    for (const point of points) {
      let bestDistance = Infinity;
      let bestEdge: Edge | null = null;
      let bestAlong = 0;
      for (const edge of this.edges.values()) {
        const projection = projectOntoEdge(edge, point);
        if (projection.dist < bestDistance) {
          bestDistance = projection.dist;
          bestEdge = edge;
          bestAlong = projection.along;
        }
      }
      // only snap if the stop is actually next to a rail
      if (bestEdge && bestDistance < 20) {
        bestEdge.stops.push(bestAlong);
      }
    }
    for (const edge of this.edges.values()) {
      edge.stops.sort((a, b) => a - b);
    }
  }

  private node(key: string): string[] {
    let incident = this.nodes.get(key);
    if (!incident) {
      incident = [];
      this.nodes.set(key, incident);
    }
    return incident;
  }

  // Find cycles via a spanning forest: every non-tree edge closes exactly one
  // fundamental cycle. Keep those that pass through the configured number of
  // crossings and are at least minCycleLength long (the minimum-length rule
  // applies to the cycle as a whole).
  private findCycles(): void {
    this.cycles.clear();
    const parent = new Map<string, string | null>();
    const parentEdge = new Map<string, string | null>();
    const visited = new Set<string>();
    for (const start of this.nodes.keys()) {
      if (visited.has(start)) continue;
      visited.add(start);
      parent.set(start, null);
      parentEdge.set(start, null);
      const queue = [start];
      for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const key of this.node(u)) {
          const edge = this.edges.get(key)!;
          const v = edge.a === u ? edge.b : edge.a;
          if (!visited.has(v)) {
            visited.add(v);
            parent.set(v, u);
            parentEdge.set(v, key);
            queue.push(v);
          }
        }
      }
    }

    const treePathKeys = (u: string, v: string): string[] => {
      const ancestors = new Set<string>();
      for (let x: string | null = u; x; x = parent.get(x) ?? null) {
        ancestors.add(x);
      }
      let lca: string | null = v;
      while (lca && !ancestors.has(lca)) lca = parent.get(lca) ?? null;
      const keys: string[] = [];
      for (let x: string | null = u; x && x !== lca; x = parent.get(x) ?? null) {
        keys.push(parentEdge.get(x)!);
      }
      for (let x: string | null = v; x && x !== lca; x = parent.get(x) ?? null) {
        keys.push(parentEdge.get(x)!);
      }
      return keys;
    };

    for (const [key, edge] of this.edges) {
      if (parentEdge.get(edge.a) === key || parentEdge.get(edge.b) === key) {
        continue; // tree edge
      }
      const keys = [key, ...treePathKeys(edge.a, edge.b)];
      const nodesOnCycle = new Set<string>();
      let length = 0;
      for (const k of keys) {
        const e = this.edges.get(k)!;
        nodesOnCycle.add(e.a);
        nodesOnCycle.add(e.b);
        length += e.length;
      }
      let crossings = 0;
      for (const node of nodesOnCycle) {
        if (this.node(node).length >= 3) crossings++;
      }
      if (
        crossings < this.config.minCycleCrossings ||
        crossings > this.config.maxCycleCrossings ||
        length < this.config.minCycleLength
      ) {
        continue;
      }
      const steps = this.orderCycle(keys, edge.a);
      if (!steps) continue;
      const id = [...keys].sort().join(",");
      if (this.cycles.has(id)) continue;
      this.cycles.set(id, { id, steps, length });
    }
  }

  // order a set of edges (a simple cycle) into a walk starting at `start`
  private orderCycle(keys: string[], start: string): Step[] | null {
    const remaining = new Set(keys);
    const steps: Step[] = [];
    let current = start;
    while (remaining.size > 0) {
      const nextKey = this.node(current).find((k) => remaining.has(k));
      if (!nextKey) return null;
      remaining.delete(nextKey);
      const edge = this.edges.get(nextKey)!;
      const dir: 1 | -1 = edge.a === current ? 1 : -1;
      const to = dir === 1 ? edge.b : edge.a;
      steps.push({ edgeKey: nextKey, dir, stop: this.node(to).length >= 3 });
      current = to;
    }
    return steps.length >= this.config.minCycleCrossings ? steps : null;
  }

  private vehicleColor(id: string): THREE.Color {
    const palette =
      this.hash01(`${id}gray`) < this.config.greyFraction
        ? this.config.greyColors
        : this.config.colors;
    return new THREE.Color(palette[(this.hash01(`${id}c`) * palette.length) | 0]);
  }

  private stopDelay(): number {
    return (
      (this.config.stopMin +
        Math.random() * (this.config.stopMax - this.config.stopMin)) *
      1000
    );
  }

  // deterministic [0, 1) hash of a string, for stable pseudo-random choices
  private hash01(s: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h / 4294967296;
  }

  // advance the fleet and write instance transforms; positions are recomputed
  // in model space from the current origin every frame
  update(originMeters: [number, number], scaleFactor: number): void {
    if (!this.enabled) return;
    const now = performance.now();
    const dt = Math.min(this.clock.getDelta(), 0.1);
    let count = 0;
    for (const v of this.vehicles) {
      const cycle = this.cycles.get(v.cycleId);
      if (!cycle) continue;
      let step = cycle.steps[v.step];
      let edge = this.edges.get(step.edgeKey);
      if (!edge) continue;

      if (now >= v.waitUntil) {
        const before = step.dir === 1 ? v.s : edge.length - v.s;
        v.s += v.speed * dt;
        if (v.s >= edge.length) {
          // reached a junction: follow the cycle (wrap at the end) and, at a
          // crossing, pause briefly (unless the fleet disables stops)
          const stop = step.stop;
          v.step = (v.step + 1) % cycle.steps.length;
          step = cycle.steps[v.step];
          v.s = 0;
          edge = this.edges.get(step.edgeKey);
          if (!edge) continue;
          if (stop && this.config.stopMax > 0) {
            v.waitUntil = now + this.stopDelay();
          }
        } else if (this.config.stopMax > 0 && edge.stops.length > 0) {
          // pause when passing a stop (e.g. a tram stop), stopping exactly on it
          const after = step.dir === 1 ? v.s : edge.length - v.s;
          const stopDistance = crossedStop(edge, before, after, step.dir);
          if (stopDistance !== null) {
            v.s = step.dir === 1 ? stopDistance : edge.length - stopDistance;
            v.waitUntil = now + this.stopDelay();
          }
        }
      }

      const distanceFromA = step.dir === 1 ? v.s : edge.length - v.s;
      const behind = pointAt(edge, distanceFromA - step.dir);
      const ahead = pointAt(edge, distanceFromA + step.dir);
      const m = toModelCoords(behind, originMeters, scaleFactor);
      const ma = toModelCoords(ahead, originMeters, scaleFactor);
      const angle = Math.atan2(ma[1] - m[1], ma[0] - m[0]);
      this.dummy.position.set(m[0], m[1], this.config.height / 2);
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
