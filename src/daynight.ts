/*
 * A pure time-of-day lighting model.
 *
 * The demo has no real sun simulation: this maps a clock hour to the handful of
 * numbers the scene lights and the window shader need, so the whole day can be
 * driven from one slider. Kept free of three.js so it is cheap to unit-test
 * (the values are plain numbers and hex colors).
 *
 * The sun is modelled as a simple arc: it rises due east at 06:00, is overhead
 * at 12:00 and sets due west at 18:00. Before dawn and after dusk the same key
 * light becomes a dim, cool moon from roughly overhead, so the scene never goes
 * completely black. Dawn and dusk are the moments the sun is near the horizon,
 * which is where the light warms and dims (the `elevation` term).
 */

export interface Lighting {
  // the key light: the sun by day, the moon at night
  keyColor: number;
  keyIntensity: number;
  // unit vector pointing from the scene toward the key light
  keyDirection: [number, number, number];
  // cool fill from roughly the opposite side, so faces away from the key are
  // not pitch black
  fillColor: number;
  fillIntensity: number;
  // hemisphere sky/ground colors and intensity
  skyColor: number;
  groundColor: number;
  hemisphereIntensity: number;
  // global exposure for the renderer's tone mapping
  exposure: number;
  // 0 in bright day, 1 at night; drives the window shader and the basemap
  night: number;
}

// noon-neutral sun, horizon-warm sun, and the cool moon
const NOON_SUN = 0xfff2df;
const HORIZON_SUN = 0xff8a4c;
const MOON = 0xc2ccdf;

const DAY_FILL = 0xbfd4ff;
const NIGHT_FILL = 0x8894b4;
const DAY_SKY = 0xcfe0ff;
// a dim, gray-blue night sky: saturated navy makes every wall look like
// blueberry, so keep the blue subtle
const NIGHT_SKY = 0x1a2130;
const DAY_GROUND = 0x4a4030;
const NIGHT_GROUND = 0x07080c;

const DAY_KEY = 2.4;
const NIGHT_KEY = 0.34;
const DAY_FILL_INTENSITY = 0.6;
const NIGHT_FILL_INTENSITY = 0.16;
const DAY_HEMI = 1.0;
const NIGHT_HEMI = 0.3;

export const DAY_HOUR = 13;
export const NIGHT_HOUR = 1;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// linear interpolation between two 0xrrggbb colors
export function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(lerp(ar, br, t));
  const g = Math.round(lerp(ag, bg, t));
  const bl = Math.round(lerp(ab, bb, t));
  return (r << 16) | (g << 8) | bl;
}

function normalize(v: [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * The lighting at a clock hour (0..24, wrapped). Noon is the brightest hour and
 * midnight the dimmest; between sunrise (06:00) and noon the key light grows
 * monotonically, and from noon to sunset (18:00) it shrinks again.
 */
export function lightingAt(hour: number): Lighting {
  const t = ((hour % 24) + 24) % 24;
  // 0 at sunrise/sunset, 1 at noon, negative during the night
  const elevation = Math.sin(((t - 6) / 12) * Math.PI);
  const daylight = clamp01(elevation);
  // 1 well into the night, 0 in bright day, ramping through dawn/dusk
  const night = clamp01((0.15 - elevation) / 0.3);

  // the sun's arc: east at 06:00, highest at 12:00, west at 18:00. The z term
  // is folded back above the horizon so the night key is a moon roughly
  // overhead rather than a light shining up from below.
  const angle = ((t - 6) / 12) * Math.PI;
  const keyDirection = normalize([
    Math.cos(angle),
    -0.35,
    Math.abs(Math.sin(angle)),
  ]);

  // warm near the horizon, neutral at noon; cool moon at night. The moon blend
  // follows `night` (not `daylight`) so a sun just above the horizon still
  // reads warm at dawn and dusk instead of flipping to moonlight.
  const dayColor = lerpColor(
    HORIZON_SUN,
    NOON_SUN,
    smoothstep(0.0, 0.45, elevation),
  );
  const keyColor = lerpColor(dayColor, MOON, night);

  return {
    keyColor,
    keyIntensity: DAY_KEY * daylight + NIGHT_KEY * night,
    keyDirection,
    fillColor: lerpColor(NIGHT_FILL, DAY_FILL, 1 - night),
    fillIntensity: lerp(NIGHT_FILL_INTENSITY, DAY_FILL_INTENSITY, 1 - night),
    skyColor: lerpColor(NIGHT_SKY, DAY_SKY, 1 - night),
    groundColor: lerpColor(NIGHT_GROUND, DAY_GROUND, 1 - night),
    hemisphereIntensity: lerp(NIGHT_HEMI, DAY_HEMI, 1 - night),
    // a touch darker at night so the moonlight does not read as daylight
    exposure: lerp(0.82, 1.0, 1 - night),
    night,
  };
}
