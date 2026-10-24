// The pure part of car mode: an arcade driving model with no road graph and no
// collision, kept free of Three.js and MapLibre so it can be unit-tested
// (src/driving.test.ts). src/driving_car.ts owns the mesh and feeds this.
//
// `heading` follows the vehicle bodies' convention: radians counter-clockwise
// from +X (east), so the mesh rotation is exactly the heading. That is also what
// src/traffic.ts samples, so a driven car points the same way as a precomputed
// one doing the same thing.

export interface DriveInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
}

export interface DriveState {
  lon: number;
  lat: number;
  // radians CCW from east; grows towards north
  heading: number;
  // m/s; negative when reversing
  speed: number;
}

export interface DriveConfig {
  // forward and reverse caps, m/s
  maxSpeed: number;
  maxReverse: number;
  // m/s^2
  acceleration: number;
  braking: number;
  // how fast the car sheds speed with no pedal, m/s^2
  coast: number;
  // turn rate at full grip, rad/s
  steerRate: number;
  // below this speed the wheel barely bites; at it the car turns fully
  fullSteerSpeed: number;
}

export const DRIVE_CONFIG: DriveConfig = {
  maxSpeed: 19.4, // ~70 km/h
  maxReverse: 4.2, // ~15 km/h
  acceleration: 6,
  braking: 16,
  coast: 3.5,
  steerRate: 1.5,
  fullSteerSpeed: 7,
};

// a single physics step is never longer than this: an arcade model integrated
// with huge steps would overshoot a turn and a frame stall would jump the car
export const MAX_DRIVE_STEP = 0.1;
// The longest frame still simulated in full. A slow machine splits a frame into
// several MAX_DRIVE_STEP substeps so the car keeps real-time speed; a background
// tab beyond this is treated as a stall rather than catching up across the city.
export const MAX_DRIVE_FRAME = 0.5;

const METERS_PER_DEGREE_LAT = 111_320;

function wrapHeading(heading: number): number {
  const turn = Math.PI * 2;
  const wrapped = heading % turn;
  return wrapped < 0 ? wrapped + turn : wrapped;
}

// true when the car at `state` would overlap a building or a fence/wall. The
// obstacle data lives in main.ts; the model only needs the predicate.
export type DriveBlocked = (state: DriveState) => boolean;

/**
 * Advance the car by `dt` seconds. Pure: the same state, input, dt and
 * `blocked` predicate always give the same result, which keeps the car's path
 * reproducible and the model testable. A frame longer than one physics step is
 * split into substeps, so a slow renderer does not turn into slow motion.
 *
 * When a substep would hit an obstacle it tries the east and north components
 * separately, so the car slides along a wall instead of sticking to it. If
 * neither helps, the car stops there. A car that is already overlapping (a
 * spawn inside a footprint) is allowed to move out rather than being trapped.
 */
export function driveStep(
  state: DriveState,
  input: DriveInput,
  dt: number,
  config: DriveConfig = DRIVE_CONFIG,
  blocked?: DriveBlocked,
): DriveState {
  let current = state;
  let remaining = Math.max(0, Math.min(dt, MAX_DRIVE_FRAME));
  while (remaining > 1e-9) {
    const step = Math.min(remaining, MAX_DRIVE_STEP);
    const candidate = driveStepOnce(current, input, step, config);
    if (!blocked || blocked(current) || !blocked(candidate)) {
      current = candidate;
    } else {
      const slide = slideStep(current, candidate, blocked);
      if (slide) {
        current = slide;
      } else {
        current = { ...current, speed: 0 };
        break;
      }
    }
    remaining -= step;
  }
  return current;
}

// Keep the component of the movement that is not blocked. Sliding in the axis
// directions rather than along the wall is a little crude, but it needs no
// obstacle normal and it reads fine at this scale.
function slideStep(
  current: DriveState,
  candidate: DriveState,
  blocked: DriveBlocked,
): DriveState | undefined {
  const east = { ...candidate, lat: current.lat };
  const north = { ...candidate, lon: current.lon };
  // a zero-length axis is not progress: with heading due east the north step
  // is the current position, and accepting it would freeze the car at speed
  const eastMoved = east.lon !== current.lon;
  const northMoved = north.lat !== current.lat;
  const eastOk = eastMoved && !blocked(east);
  const northOk = northMoved && !blocked(north);
  if (eastOk && northOk) {
    // both axes alone are free but the diagonal is not (a corner); keep the
    // larger component, i.e. the direction most aligned with the intended move
    return Math.abs(east.lon - current.lon) >= Math.abs(north.lat - current.lat)
      ? east
      : north;
  }
  if (eastOk) return east;
  if (northOk) return north;
  return undefined;
}

function driveStepOnce(
  state: DriveState,
  input: DriveInput,
  step: number,
  config: DriveConfig,
): DriveState {
  let speed = state.speed;

  if (input.forward && !input.backward) {
    speed += config.acceleration * step;
  } else if (input.backward && !input.forward) {
    // the brake pedal first stops a forward car; only then does it reverse
    speed =
      speed > 0
        ? Math.max(0, speed - config.braking * step)
        : speed - config.acceleration * step;
  } else {
    // coasting (or both pedals held, which is a wash)
    const drop = config.coast * step;
    speed = Math.abs(speed) <= drop ? 0 : speed - Math.sign(speed) * drop;
  }
  speed = Math.max(-config.maxReverse, Math.min(config.maxSpeed, speed));

  // a stopped car cannot turn on the spot; at speed the wheel bites fully. The
  // sign of the speed flips the steering when reversing, like a real car.
  const steer = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  const grip = Math.min(1, Math.abs(speed) / config.fullSteerSpeed);
  const heading = wrapHeading(
    state.heading + steer * config.steerRate * grip * Math.sign(speed) * step,
  );

  const north = Math.sin(heading) * speed * step;
  const east = Math.cos(heading) * speed * step;
  const metersPerDegreeLon =
    METERS_PER_DEGREE_LAT * Math.cos((state.lat * Math.PI) / 180);
  return {
    lon: state.lon + east / Math.max(1e-6, metersPerDegreeLon),
    lat: state.lat + north / METERS_PER_DEGREE_LAT,
    heading,
    speed,
  };
}

/**
 * The heading as a MapLibre bearing (degrees clockwise from north). MapLibre
 * turns the map by the bearing, so the camera looks where the car is going.
 */
export function headingToBearing(heading: number): number {
  const degrees = ((heading * 180) / Math.PI) % 360;
  const bearing = 90 - degrees;
  const wrapped = bearing % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * `meters` along the heading, used to put the chase camera's look point a
 * little ahead of the car so the road takes the center of the screen. An
 * equirectangular step is accurate enough over a few dozen meters.
 */
export function pointAhead(
  lon: number,
  lat: number,
  heading: number,
  meters: number,
): [number, number] {
  const metersPerDegreeLon =
    METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
  return [
    lon + (Math.cos(heading) * meters) / Math.max(1e-6, metersPerDegreeLon),
    lat + (Math.sin(heading) * meters) / METERS_PER_DEGREE_LAT,
  ];
}

/** The heading that points the car the way the map is currently facing. */
export function headingFromBearing(bearing: number): number {
  return wrapHeading(Math.PI / 2 - (bearing * Math.PI) / 180);
}
