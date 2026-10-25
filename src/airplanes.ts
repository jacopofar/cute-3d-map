import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";

import { toModelCoords } from "./projection";
import type { RunwayLine } from "./geojson_data";
import { applyVertexColor } from "./elements3d/vertex_color";

/*
 * A decorative layer of airliners flying out of (and into) the loaded runways.
 *
 * Like the clouds and the traffic, nothing is simulated: each runway carries a
 * seeded schedule, and a plane's position, heading and altitude are a pure
 * function of wall-clock time. There is no state to advance, so a tile arriving
 * or leaving only changes which runways are present (setRunways).
 *
 * A runway is quiet most of the time — a flight is scheduled in only some of
 * its periods, and even then it is only drawn for the ~30 s of the takeoff or
 * landing. Off-schedule the instance is hidden with a zero-scale matrix (the
 * TrafficRenderer trick), so the draw cost is one small InstancedMesh.
 *
 * The plane is only worth drawing once the map is close enough for a 30 m
 * airliner to read; below PLANE_MIN_ZOOM the whole layer is hidden and the
 * per-frame work skipped.
 */

// a 30 m airliner is ~18 px at zoom 16 (Milan's latitude) and about half that
// at 15, where it is a speck; gate the layer there like the vehicle traffic
export const PLANE_MIN_ZOOM = 16;

// real-world length of the airliner mesh, in meters
const PLANE_LENGTH = 30;

// The schedule: within one `period` a runway may run a single flight, at a
// seeded offset; the rest of the period is quiet. ~72% of periods have a flight
// and a flight is drawn for ~31 s of a 60-84 s period, so a plane is visible
// roughly a quarter to a third of the time — "now and then", not a shuttle.
const EVENT_CHANCE = 72; // percent of periods with a flight
const TAKEOFF_SHARE = 62; // of the flights, percent that are departures
// A takeoff: line up, roll, then climb out and vanish. The climb is long and
// accelerating on purpose: the plane gains altitude fast enough to leave the
// eye before the schedule hides it, so the pop is a speck disappearing rather
// than the mesh shrinking in mid-air.
const TAKEOFF_SECONDS = 34; // 2 + 16 + 16
const LANDING_SECONDS = 29; // 14 + 12 + 3
// the sub-phases inside those, in seconds
const TAKEOFF_LINEUP = 2;
const TAKEOFF_ROLL = 16;
const LANDING_APPROACH = 14;
const LANDING_ROLL = 12;
// how far past the runway end a departing/arriving plane travels, as a fraction
// of the runway length (the climb keeps accelerating through it)
const OVERRUN_FRACTION = 0.8;
// the altitude a departing plane reaches when the schedule hides it; the climb
// is accelerating (altitude ∝ f^1.8), so it lifts off gently and is climbing
// hard at the end
const CLIMB_METERS = 650;
const TAKEOFF_PITCH = (12 * Math.PI) / 180;
// the altitude on final a landing plane starts its approach from
const APPROACH_METERS = 220;
// parked airliners: how far apart along an apron edge, how far inside the edge,
// and at most how many on one apron
const PARKING_SPACING = 120;
const PARKING_INSET = 24;
const MAX_PARKED_PER_APRON = 3;

interface PreparedRunway {
  id: string;
  seed: number;
  points: [number, number][];
  // cumulative distance in meters to each point, and the total length
  cum: number[];
  total: number;
  period: number; // seconds between two flights
  offset: number; // seconds, so two runways do not fire in lockstep
}

// a stationary airliner parked on an apron, placed from the apron's outline
interface ParkedPlane {
  lon: number;
  lat: number;
  heading: number; // radians, model space
}

interface Flight {
  lon: number;
  lat: number;
  heading: number; // radians, model space, +x east / +y north
  altitude: number; // meters above ground
  pitch: number; // radians, positive nose up
  scale: number; // 0 hides the instance
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const DEG2RAD = Math.PI / 180;

// 32-bit string hash (FNV-1a), so a runway id seeds its own schedule
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mix an integer into a hash: `mix(seed, k)` is the k-th draw of that seed
function mix(seed: number, k: number): number {
  let h = (seed ^ Math.imul(k + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function smoothstep(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

const METERS_PER_DEG_LAT = 110540;
const METERS_PER_DEG_LON = 111320;

function segHeading(a: [number, number], b: [number, number]): number {
  const cosLat = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.atan2(
    (b[1] - a[1]) * METERS_PER_DEG_LAT,
    (b[0] - a[0]) * METERS_PER_DEG_LON * cosLat,
  );
}

function segLength(a: [number, number], b: [number, number]): number {
  const cosLat = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot(
    (b[0] - a[0]) * METERS_PER_DEG_LON * cosLat,
    (b[1] - a[1]) * METERS_PER_DEG_LAT,
  );
}

// point at `u` along the runway, u in units of the runway length (0 = the
// stored start end, 1 = the far end). Out-of-range values extrapolate along the
// first/last segment, which is how a plane climbs out past the threshold.
function pointAt(
  rw: PreparedRunway,
  u: number,
): { lon: number; lat: number; heading: number } {
  const { points, cum, total } = rw;
  const target = u * total;
  if (target <= 0) {
    // extrapolate backwards past the stored start: `local` is negative, and the
    // plane arrives at `a` from `b`, so it keeps going in the a - b direction
    const a = points[0];
    const b = points[1];
    const len = segLength(a, b) || 1;
    const local = target / len;
    return {
      lon: a[0] + (b[0] - a[0]) * local,
      lat: a[1] + (b[1] - a[1]) * local,
      heading: segHeading(a, b),
    };
  }
  if (target >= total) {
    const a = points[points.length - 2];
    const b = points[points.length - 1];
    const len = segLength(a, b) || 1;
    const local = (target - total) / len;
    return {
      lon: b[0] + (b[0] - a[0]) * local,
      lat: b[1] + (b[1] - a[1]) * local,
      heading: segHeading(a, b),
    };
  }
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const a = points[i - 1];
  const b = points[i];
  const span = cum[i] - cum[i - 1] || 1;
  const t = (target - cum[i - 1]) / span;
  return {
    lon: a[0] + (b[0] - a[0]) * t,
    lat: a[1] + (b[1] - a[1]) * t,
    heading: segHeading(a, b),
  };
}

// turn a flight's path parameter (u along the runway, from the takeoff end) and
// flight time into a placed plane. `reversed` runs from the far end instead.
function flightState(
  rw: PreparedRunway,
  local: number,
  isTakeoff: boolean,
  reversed: boolean,
): Flight | null {
  let u: number;
  let altitude = 0;
  let pitch = 0;
  let scale = 1;

  if (isTakeoff) {
    const climb = TAKEOFF_SECONDS - TAKEOFF_LINEUP - TAKEOFF_ROLL;
    if (local < TAKEOFF_LINEUP) {
      // lined up at the threshold, engines spooling
      u = 0;
    } else if (local < TAKEOFF_LINEUP + TAKEOFF_ROLL) {
      // the takeoff roll: accelerate along the runway, rotating near the end
      const f = (local - TAKEOFF_LINEUP) / TAKEOFF_ROLL;
      u = f ** 1.7;
      pitch = TAKEOFF_PITCH * smoothstep((f - 0.85) / 0.15);
    } else {
      // climb out past the far threshold, accelerating both along the ground
      // and upward; the schedule hides the plane at the end of this, by which
      // point it is a speck high above the runway
      const f = (local - TAKEOFF_LINEUP - TAKEOFF_ROLL) / climb;
      u = 1 + OVERRUN_FRACTION * f ** 1.5;
      altitude = CLIMB_METERS * f ** 1.8;
      pitch = TAKEOFF_PITCH;
    }
  } else {
    const exit = LANDING_SECONDS - LANDING_APPROACH - LANDING_ROLL;
    if (local < LANDING_APPROACH) {
      // on final: descend toward the touchdown zone, nose a touch up
      const f = local / LANDING_APPROACH;
      u = 1 + OVERRUN_FRACTION - f * (0.1 + OVERRUN_FRACTION);
      altitude = APPROACH_METERS * (1 - f);
      pitch = 3 * DEG2RAD;
    } else if (local < LANDING_APPROACH + LANDING_ROLL) {
      // touch down and roll out, decelerating toward the taxiway
      const f = (local - LANDING_APPROACH) / LANDING_ROLL;
      u = 0.9 - f * 0.75;
    } else {
      // leave the runway and fade (there is no taxiway path to follow)
      const f = (local - LANDING_APPROACH - LANDING_ROLL) / exit;
      u = 0.15 - f * 0.12;
      scale = 1 - f;
    }
  }

  if (reversed) u = 1 - u;
  const p = pointAt(rw, u);
  // a plane flying the other way points the other way
  const heading = p.heading + (reversed ? Math.PI : 0);
  return { lon: p.lon, lat: p.lat, heading, altitude, pitch, scale };
}

// the flight (if any) drawn on `rw` at wall-clock second `t`
function flightAt(rw: PreparedRunway, t: number): Flight | null {
  const shifted = t + rw.offset;
  const k = Math.floor(shifted / rw.period);
  const local = shifted - k * rw.period;
  const h = mix(rw.seed, k);
  if (h % 100 >= EVENT_CHANCE) return null;
  const isTakeoff = (h >>> 7) % 100 < TAKEOFF_SHARE;
  const duration = isTakeoff ? TAKEOFF_SECONDS : LANDING_SECONDS;
  const reversed = ((h >>> 15) & 1) === 1;
  // keep the flight inside its period rather than wrapping into the next one
  const start = (h >>> 4) % Math.max(1, Math.round(rw.period - duration));
  const into = local - start;
  if (into < 0 || into >= duration) return null;
  return flightState(rw, into, isTakeoff, reversed);
}

// One shared low-poly airliner, built from boxes (fuselage, engines, tail) and
// two extruded wing planforms, ~30 m long and pointing along +x. Colors are
// baked per part, so the whole plane is one instanced draw.
function airlinerGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const paint = (geometry: THREE.BufferGeometry, color: string) => {
    // the boxes are indexed and the extruded wings are not; mergeGeometries
    // needs them to agree, so flatten everything to non-indexed first
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    applyVertexColor(flat, new THREE.Color(color));
    parts.push(flat);
  };

  // fuselage, sitting ~1 m clear of the ground on its gear
  const body = new THREE.BoxGeometry(PLANE_LENGTH - 4, 3.6, 4.2);
  body.translate(0, 0, 3.2);
  paint(body, "#eef1f5");

  // nose and tail cones, so the silhouette is not a plain brick
  const nose = new THREE.BoxGeometry(4, 2.6, 2.8);
  nose.translate(PLANE_LENGTH / 2 - 2, 0, 3.1);
  paint(nose, "#eef1f5");
  const tailCone = new THREE.BoxGeometry(4, 2.2, 3.2);
  tailCone.translate(-PLANE_LENGTH / 2 + 1, 0, 4.0);
  paint(tailCone, "#dfe3ea");

  const wing = (sign: number): THREE.BufferGeometry => {
    const shape = new THREE.Shape();
    shape.moveTo(7, 0); // root leading edge
    shape.lineTo(-3, 13); // tip leading edge (swept back)
    shape.lineTo(-7.5, 13); // tip trailing edge
    shape.lineTo(-2, 0); // root trailing edge
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 0.9,
      bevelEnabled: false,
    });
    geometry.translate(0, 0, 2.6);
    if (sign < 0) {
      geometry.scale(1, -1, 1);
      // the mirror flips the winding; recompute so the left wing is lit too
      geometry.computeVertexNormals();
    }
    return geometry;
  };
  paint(wing(1), "#c2c8d0");
  paint(wing(-1), "#c2c8d0");

  // two engines slung under the wings
  const engine = (y: number): THREE.BufferGeometry => {
    const box = new THREE.BoxGeometry(3.4, 2, 2);
    box.translate(-1, y, 1.9);
    return box;
  };
  paint(engine(6.5), "#3d4350");
  paint(engine(-6.5), "#3d4350");

  // the vertical fin, leaning back
  const fin = new THREE.BoxGeometry(7, 0.7, 7.5);
  fin.rotateY(-0.32);
  fin.translate(-PLANE_LENGTH / 2 + 3.5, 0, 7.4);
  paint(fin, "#2b6cb0");

  // a swept horizontal stabilizer, one box per side
  const stab = (sign: number): THREE.BufferGeometry => {
    const box = new THREE.BoxGeometry(4, 6, 0.7);
    box.rotateZ(sign * 0.28);
    box.translate(-PLANE_LENGTH / 2 + 3, sign * 3.2, 4.4);
    return box;
  };
  paint(stab(1), "#c2c8d0");
  paint(stab(-1), "#c2c8d0");

  // a cheatline down the fuselage sides, for a little livery
  const stripe = new THREE.BoxGeometry(PLANE_LENGTH - 6, 3.75, 0.7);
  stripe.translate(0, 0, 2.4);
  paint(stripe, "#2b6cb0");

  const merged = BufferGeometryUtils.mergeGeometries(parts);
  if (!merged) {
    // should not happen (every part carries position/normal/uv/color)
    console.warn("airplanes: could not merge the airliner geometry");
    return parts[0];
  }
  return merged;
}

/**
 * Renders the seeded flights out of the loaded runways. There is no state: a
 * plane is placed from the runway's schedule and wall-clock time each frame, so
 * panning, an origin reset or a tile arriving never disrupts a flight.
 */
export class PlaneLayer {
  private readonly mesh: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly yaw = new THREE.Quaternion();
  private readonly pitchQ = new THREE.Quaternion();
  private readonly capacity: number;
  private runways: PreparedRunway[] = [];
  private parked: ParkedPlane[] = [];
  private enabled = true;

  constructor(scene: THREE.Scene, capacity = 64) {
    this.capacity = capacity;
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mesh = new THREE.InstancedMesh(
      airlinerGeometry(),
      material,
      this.capacity,
    );
    this.mesh.count = 0;
    // instances move every frame, so frustum culling against stale bounds would
    // hide them
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // so the e2e can find the layer
    this.mesh.userData = { kind: "airplane" };
    scene.add(this.mesh);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.mesh.visible = enabled;
  }

  // the union of the loaded tiles' runways, already deduped by id in main.ts
  setRunways(runways: RunwayLine[]): void {
    const prepared: PreparedRunway[] = [];
    for (const runway of runways) {
      if (runway.coords.length < 2) continue;
      const cum = [0];
      for (let i = 1; i < runway.coords.length; i++) {
        cum.push(
          cum[i - 1] + segLength(runway.coords[i - 1], runway.coords[i]),
        );
      }
      const total = cum[cum.length - 1];
      // runways shorter than this are not worth a flight (and the schedule
      // math wants some length to roll on)
      if (total < 200) continue;
      const seed = hashString(runway.id);
      prepared.push({
        id: runway.id,
        seed,
        points: runway.coords,
        cum,
        total,
        period: 60 + (seed % 3) * 12,
        offset: (mix(seed, 1) % 60_000) / 1000,
      });
    }
    if (prepared.length > this.capacity) {
      console.warn(
        `airplanes: ${prepared.length} runways exceed the ${this.capacity} instance capacity`,
      );
      prepared.length = this.capacity;
    }
    this.runways = prepared;
  }

  // The apron outlines the loaded tiles carry, deduped by id in main.ts. A
  // parked airliner is placed along the apron's longest edge, nose-in toward
  // that edge, so a row of them reads as aircraft at the stands.
  setAprons(rings: [number, number][][]): void {
    const parked: ParkedPlane[] = [];
    for (const ring of rings) {
      if (ring.length < 4) continue;
      // the longest edge, which a terminal apron lines with
      let best = 0;
      let edge = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const length = segLength(ring[i], ring[i + 1]);
        if (length > best) {
          best = length;
          edge = i;
        }
      }
      if (best < 60) continue;
      const a = ring[edge];
      const b = ring[edge + 1];
      const heading = segHeading(a, b);
      const cosLat = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
      // the edge normal in meters (east, north), flipped to point at the
      // apron's inside (its vertex average)
      let nEast = -Math.sin(heading);
      let nNorth = Math.cos(heading);
      let cEast = 0;
      let cNorth = 0;
      const midLon = (a[0] + b[0]) / 2;
      const midLat = (a[1] + b[1]) / 2;
      for (const point of ring) {
        cEast += (point[0] - midLon) * METERS_PER_DEG_LON * cosLat;
        cNorth += (point[1] - midLat) * METERS_PER_DEG_LAT;
      }
      if (nEast * cEast + nNorth * cNorth < 0) {
        nEast = -nEast;
        nNorth = -nNorth;
      }
      // nose-in means the plane points back out of the apron, at the edge
      const parkedHeading = Math.atan2(-nNorth, -nEast);
      const count = Math.min(
        MAX_PARKED_PER_APRON,
        Math.max(1, Math.round(best / PARKING_SPACING)),
      );
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0.5 : (i + 0.5) / count;
        parked.push({
          lon:
            a[0] +
            (b[0] - a[0]) * t +
            (nEast * PARKING_INSET) / (METERS_PER_DEG_LON * cosLat),
          lat:
            a[1] +
            (b[1] - a[1]) * t +
            (nNorth * PARKING_INSET) / METERS_PER_DEG_LAT,
          heading: parkedHeading,
        });
      }
    }
    this.parked = parked;
  }

  // place a plane for every runway for the current wall-clock phase
  update(
    originMeters: [number, number],
    scaleFactor: number,
    view: { zoom: number; now: number },
  ): void {
    const visible = this.enabled && view.zoom >= PLANE_MIN_ZOOM;
    this.mesh.visible = visible;
    if (!visible) return;
    const t = view.now / 1000;
    let slot = 0;
    for (const runway of this.runways) {
      const flight = flightAt(runway, t);
      if (!flight || flight.scale <= 0) {
        this.mesh.setMatrixAt(slot, this.hidden);
        slot++;
        continue;
      }
      const m = toModelCoords(
        [flight.lon, flight.lat],
        originMeters,
        scaleFactor,
      );
      this.dummy.position.set(m[0], m[1], flight.altitude);
      this.yaw.setFromAxisAngle(Z_AXIS, flight.heading);
      this.pitchQ.setFromAxisAngle(Y_AXIS, -flight.pitch);
      this.dummy.quaternion.copy(this.yaw).multiply(this.pitchQ);
      this.dummy.scale.setScalar(flight.scale);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(slot, this.dummy.matrix);
      slot++;
    }
    // the parked airliners are static: no schedule, no altitude, always up
    for (const plane of this.parked) {
      if (slot >= this.capacity) break;
      const m = toModelCoords(
        [plane.lon, plane.lat],
        originMeters,
        scaleFactor,
      );
      this.dummy.position.set(m[0], m[1], 0);
      this.yaw.setFromAxisAngle(Z_AXIS, plane.heading);
      this.dummy.quaternion.copy(this.yaw);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(slot, this.dummy.matrix);
      slot++;
    }
    this.mesh.count = slot;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
