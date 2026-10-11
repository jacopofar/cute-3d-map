import * as THREE from "three";

import { toModelCoords, type Road } from "./geojson_data";

const CAR_LENGTH = 8 / 3;
const CAR_WIDTH = 4 / 3;
const CAR_HEIGHT = 1;
const MIN_SPACING = 12.5; // meters between cars spawned on one edge
const MAX_VEHICLES = 4000;
const SPEED_MIN = 6; // m/s
const SPEED_MAX = 16;
const STOP_MIN = 0.4; // seconds paused when arriving at a crossing
const STOP_MAX = 1.5;
const MIN_EDGE_LENGTH = 1; // ignore degenerate edges (meters)

const CAR_COLORS = [
  0xff5555, 0x5555ff, 0xffffff, 0x222222, 0xffcc33, 0x33cc99, 0xcccccc,
  0x99bbff,
];

// one road segment between two graph nodes
interface Edge {
  key: string;
  a: string; // node key at pts[0]
  b: string; // node key at pts[last]
  pts: [number, number][];
  cum: number[]; // cumulative meters from `a`
  length: number;
}

interface GraphNode {
  edges: string[]; // incident edge keys
}

interface Vehicle {
  id: string; // stable `${edgeKey}#${slot}`
  edgeKey: string;
  dir: 1 | -1; // +1 travels a -> b, -1 travels b -> a
  s: number; // meters travelled since entering the current edge
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
  // Roads are pulled into a single graph spanning every loaded tile, so a car
  // can drive out of one tile and into the next one. Nodes are road
  // endpoints; a node with three or more edges is a crossing, where cars pick
  // a (random) branch and briefly stop.
  private readonly mesh: THREE.InstancedMesh;
  private readonly edges = new Map<string, Edge>();
  private readonly nodes = new Map<string, GraphNode>();
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

    // Pick which cars to show by a stable bottom-k hash over every (edge,
    // slot) candidate, so the fleet spreads uniformly over the whole graph
    // (rather than greedily filling the cap on the first tiles that load).
    const candidates: { id: string; edgeKey: string; slot: number; key: number }[] =
      [];
    for (const [key, edge] of this.edges) {
      const n = Math.max(1, Math.floor(edge.length / MIN_SPACING));
      for (let i = 0; i < n; i++) {
        const id = `${key}#${i}`;
        candidates.push({ id, edgeKey: key, slot: i, key: this.hash01(id) });
      }
    }
    candidates.sort((a, b) => a.key - b.key);

    const vehicles: Vehicle[] = [];
    for (const candidate of candidates.slice(0, MAX_VEHICLES)) {
      const existing = this.byId.get(candidate.id);
      if (existing) {
        // keep the car (and its current route) as tiles load/unload
        vehicles.push(existing);
        continue;
      }
      const edge = this.edges.get(candidate.edgeKey);
      if (!edge) continue;
      const n = Math.max(1, Math.floor(edge.length / MIN_SPACING));
      vehicles.push({
        id: candidate.id,
        edgeKey: candidate.edgeKey,
        dir: this.hash01(`${candidate.id}d`) < 0.5 ? 1 : -1,
        s: ((candidate.slot + 0.5) / n) * edge.length,
        speed:
          SPEED_MIN + this.hash01(`${candidate.id}s`) * (SPEED_MAX - SPEED_MIN),
        waitUntil: 0,
        color: new THREE.Color(
          CAR_COLORS[(this.hash01(`${candidate.id}c`) * CAR_COLORS.length) | 0],
        ),
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
      this.node(a).edges.push(key);
      this.node(b).edges.push(key);
    }
  }

  private node(key: string): GraphNode {
    let node = this.nodes.get(key);
    if (!node) {
      node = { edges: [] };
      this.nodes.set(key, node);
    }
    return node;
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
      let edge = this.edges.get(v.edgeKey);
      if (!edge) continue;
      if (now >= v.waitUntil) {
        v.s += v.speed * dt;
        if (v.s >= edge.length) {
          this.arrive(v, edge, now);
          edge = this.edges.get(v.edgeKey);
          if (!edge) continue;
        }
      }
      const distanceFromA = v.dir === 1 ? v.s : edge.length - v.s;
      const behind = pointAt(edge, distanceFromA - v.dir);
      const ahead = pointAt(edge, distanceFromA + v.dir);
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

  // reached the end of the current edge: pick a branch at the junction. At a
  // dead end, turn around. At a crossing (>= 3 edges), pause briefly.
  private arrive(v: Vehicle, edge: Edge, now: number): void {
    const toKey = v.dir === 1 ? edge.b : edge.a;
    const node = this.nodes.get(toKey);
    if (!node) return;
    let options = node.edges.filter((key) => key !== edge.key);
    if (options.length === 0) options = [edge.key]; // dead end -> U-turn
    const nextKey = options[Math.floor(Math.random() * options.length)];
    const next = this.edges.get(nextKey);
    if (!next) return;
    v.dir = next.a === toKey ? 1 : -1;
    v.edgeKey = nextKey;
    v.s = 0;
    if (node.edges.length >= 3) {
      v.waitUntil = now + (STOP_MIN + Math.random() * (STOP_MAX - STOP_MIN)) * 1000;
    }
  }
}
