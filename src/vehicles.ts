import * as THREE from "three";

import { toModelCoords, type Road } from "./geojson_data";

const CAR_LENGTH = 8 / 3;
const CAR_WIDTH = 4 / 3;
const CAR_HEIGHT = 1;
const MIN_SPACING = 12.5; // meters between cars spawned on one cycle
const MAX_VEHICLES = 4000;
const SPEED_MIN = 6; // m/s
const SPEED_MAX = 16;
const STOP_MIN = 0.4; // seconds paused when arriving at a crossing
const STOP_MAX = 1.5;
const MIN_EDGE_LENGTH = 1; // ignore degenerate edges (meters)

// a drivable cycle must pass through this many crossings (degree >= 3 nodes)
// and be at least this long; the 50 m rule applies to the cycle as a whole
const MIN_CYCLE_CROSSINGS = 3;
const MAX_CYCLE_CROSSINGS = 10;
const MIN_CYCLE_LENGTH = 50;

// 60% of cars use a grey shade, the rest a colour
const GREY_COLORS = [0xe0e0e0, 0xb0b0b0, 0x888888, 0x555555, 0x333333, 0xa8a8a8];
const CAR_COLORS = [0xff5555, 0x5555ff, 0xffcc33, 0x33cc99];

// one road segment between two graph nodes
interface Edge {
  key: string;
  a: string; // node key at pts[0]
  b: string; // node key at pts[last]
  pts: [number, number][];
  cum: number[]; // cumulative meters from `a`
  length: number;
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
  waitUntil: number; // ms timestamp: while in the future the car is stopped
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

// a node id shared by roads meeting at the same point. Coordinates are
// rounded so tile-clipped endpoints on a shared boundary collide exactly.
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

export class VehicleManager {
  // Roads from every loaded tile are pulled into one graph, so a cycle can
  // run across tile boundaries. Cars then loop their cycle: no ping-pong, and
  // at each crossing they may take a different branch (different cycles), with
  // a brief stop.
  private readonly mesh: THREE.InstancedMesh;
  private readonly edges = new Map<string, Edge>();
  private readonly nodes = new Map<string, string[]>(); // node -> incident edge keys
  private readonly cycles = new Map<string, Cycle>();
  private vehicles: Vehicle[] = [];
  private byId = new Map<string, Vehicle>();
  private readonly dummy = new THREE.Object3D();
  private readonly clock = new THREE.Clock();

  constructor(scene: THREE.Scene) {
    const geometry = new THREE.BoxGeometry(CAR_LENGTH, CAR_WIDTH, CAR_HEIGHT);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_VEHICLES);
    this.mesh.count = 0;
    // instances move every frame, so frustum culling against stale bounds
    // would hide them
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  setRoads(roads: Road[]): void {
    this.buildGraph(roads);
    this.findCycles();

    // Pick which cars to show by a stable bottom-k hash over every (cycle,
    // slot) candidate, so the fleet spreads uniformly over the whole graph
    // rather than greedily filling the cap on the first tiles that load.
    const candidates: { id: string; cycleId: string; slot: number; key: number }[] =
      [];
    for (const [cycleId, cycle] of this.cycles) {
      const n = Math.max(1, Math.floor(cycle.length / MIN_SPACING));
      for (let i = 0; i < n; i++) {
        const id = `${cycleId}#${i}`;
        candidates.push({ id, cycleId, slot: i, key: this.hash01(id) });
      }
    }
    candidates.sort((a, b) => a.key - b.key);

    const vehicles: Vehicle[] = [];
    for (const candidate of candidates.slice(0, MAX_VEHICLES)) {
      const existing = this.byId.get(candidate.id);
      if (existing) {
        // keep the car (and its progress along the cycle) across re-syncs
        vehicles.push(existing);
        continue;
      }
      const cycle = this.cycles.get(candidate.cycleId);
      if (!cycle) continue;
      const step = Math.floor(this.hash01(`${candidate.id}step`) * cycle.steps.length);
      const edge = this.edges.get(cycle.steps[step].edgeKey);
      vehicles.push({
        id: candidate.id,
        cycleId: candidate.cycleId,
        step,
        s: this.hash01(`${candidate.id}s`) * (edge?.length ?? 0),
        speed:
          SPEED_MIN + this.hash01(`${candidate.id}v`) * (SPEED_MAX - SPEED_MIN),
        waitUntil: 0,
        color: this.carColor(candidate.id),
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
      if (length < MIN_EDGE_LENGTH) continue;
      this.edges.set(key, { key, a, b, pts, cum, length });
      this.node(a).push(key);
      this.node(b).push(key);
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
  // fundamental cycle. Keep those that pass through 3..10 crossings and are at
  // least MIN_CYCLE_LENGTH long (the minimum-length rule for cycles).
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
        crossings < MIN_CYCLE_CROSSINGS ||
        crossings > MAX_CYCLE_CROSSINGS ||
        length < MIN_CYCLE_LENGTH
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
    return steps.length >= MIN_CYCLE_CROSSINGS ? steps : null;
  }

  private carColor(id: string): THREE.Color {
    const palette =
      this.hash01(`${id}gray`) < 0.6 ? GREY_COLORS : CAR_COLORS;
    return new THREE.Color(palette[(this.hash01(`${id}c`) * palette.length) | 0]);
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
        v.s += v.speed * dt;
        if (v.s >= edge.length) {
          // reached a junction: follow the cycle (wrap at the end) and, at a
          // crossing, pause briefly
          const stop = step.stop;
          v.step = (v.step + 1) % cycle.steps.length;
          step = cycle.steps[v.step];
          v.s = 0;
          edge = this.edges.get(step.edgeKey);
          if (!edge) continue;
          if (stop) {
            v.waitUntil =
              now + (STOP_MIN + Math.random() * (STOP_MAX - STOP_MIN)) * 1000;
          }
        }
      }

      const distanceFromA = step.dir === 1 ? v.s : edge.length - v.s;
      const behind = pointAt(edge, distanceFromA - step.dir);
      const ahead = pointAt(edge, distanceFromA + step.dir);
      const m = toModelCoords(behind, originMeters, scaleFactor);
      const ma = toModelCoords(ahead, originMeters, scaleFactor);
      const angle = Math.atan2(ma[1] - m[1], ma[0] - m[0]);
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
