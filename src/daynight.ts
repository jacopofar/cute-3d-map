/*
 * An approximate time-of-day lighting model, driven by the real sun over Milan.
 *
 * The demo has no ephemeris or weather simulation: the sun's declination is the
 * usual one-term approximation for the date, and its hour angle comes from the
 * hour as local mean solar time (12 is solar noon). That is enough for the scene
 * to be dark when it is dark in Milan, for the key light to sit low and warm in
 * winter and high in summer, and for the opening state to match the current sun
 * instead of a fixed equinox arc.
 *
 * The hour is local mean solar time at Milan: the app seeds it from UTC plus the
 * longitude offset (see currentMilanSolarHour), so the slider reads true solar
 * time rather than a DST-dependent clock. Kept free of three.js so it is cheap to
 * unit-test (the values are plain numbers and hex colors).
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

// the tiles are a Milan extract, so the sun is the sun over Milan
export const MILAN_LAT = 45.4642;
export const MILAN_LON = 9.19;

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

const DEG = Math.PI / 180;

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

// day of the year, 1..366, from the UTC date
function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((date.getTime() - start) / 86_400_000);
}

// Cooper's approximation of the solar declination, good to about a degree
function solarDeclination(date: Date): number {
  return (
    23.44 * DEG * Math.sin(((2 * Math.PI) / 365) * (284 + dayOfYear(date)))
  );
}

/**
 * The unit vector toward the sun at a local mean solar hour, in the model's
 * east/north/up frame. `up` is negative when the sun is below the horizon.
 */
export function sunDirection(
  hour: number,
  date: Date,
): [number, number, number] {
  const declination = solarDeclination(date);
  const latitude = MILAN_LAT * DEG;
  // hour angle: 0 at solar noon, positive in the afternoon (the sun to the west)
  const hourAngle = (hour - 12) * 15 * DEG;
  const east = -Math.cos(declination) * Math.sin(hourAngle);
  const north =
    Math.sin(declination) * Math.cos(latitude) -
    Math.cos(declination) * Math.sin(latitude) * Math.cos(hourAngle);
  const up =
    Math.sin(declination) * Math.sin(latitude) +
    Math.cos(declination) * Math.cos(latitude) * Math.cos(hourAngle);
  return [east, north, up];
}

/**
 * The current local mean solar hour in Milan (0..24). UTC plus the longitude
 * offset: this is the sun's clock, so it is unaffected by daylight saving time.
 */
export function currentMilanSolarHour(now: Date = new Date()): number {
  const utcHours =
    now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  return (((utcHours + MILAN_LON / 15) % 24) + 24) % 24;
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
 * The lighting at a local mean solar hour (0..24, wrapped) on a given date
 * (defaults to today). Solar noon is the brightest hour and solar midnight the
 * dimmest; the key light follows the real sun's altitude and azimuth for Milan,
 * so the winter sun is lower and the summer evening stays light longer.
 */
export function lightingAt(hour: number, date: Date = new Date()): Lighting {
  const t = ((hour % 24) + 24) % 24;
  const [east, north, up] = sunDirection(t, date);
  const altitude = Math.asin(Math.max(-1, Math.min(1, up))) / DEG;

  // the sun fades in as it clears the horizon; night takes over through civil
  // twilight (a few degrees below the horizon)
  const daylight = smoothstep(-2, 10, altitude);
  const night = 1 - smoothstep(-8, 2, altitude);

  // warm near the horizon, neutral once the sun is well up; cool moon at night.
  // The moon blend follows `night` so a sun just above the horizon still reads
  // warm at dawn and dusk instead of flipping to moonlight.
  const dayColor = lerpColor(
    HORIZON_SUN,
    NOON_SUN,
    smoothstep(2, 25, altitude),
  );
  const keyColor = lerpColor(dayColor, MOON, night);

  // by day the real sun direction; at night it blends toward a moon roughly
  // overhead, so the key never shines up from below the ground
  const keyDirection = normalize([
    east * (1 - night),
    north * (1 - night) - 0.35 * night,
    Math.max(up, 0) * (1 - night) + night,
  ]);

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
