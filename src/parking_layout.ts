/*
 * Placement of static parked cars along the rows tilegen authors.
 *
 * tilegen owns the parking logic: it emits one line per side of a road, with a
 * style (parallel/perpendicular/fishbone), a pitch and an occupancy. This module
 * walks those lines and places the cars in model space; the renderer never
 * needs to know how a bay was chosen, only where the car goes.
 */

export interface ParkingRow {
  id?: string;
  coords: [number, number][];
  style: string;
  pitch: number;
  side: number;
  occupancy?: number;
}

export interface PlacedParkedCar {
  lon: number;
  lat: number;
  heading: number;
}

const METERS_PER_DEG_LAT = 110540;
const METERS_PER_DEG_LON = 111320;
const DEFAULT_PITCH = 5.2;
const DEFAULT_OCCUPANCY = 95;

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value;
}

function headingFor(roadHeading: number, side: number, style: string): number {
  if (style === "parallel") return roadHeading + (side > 0 ? Math.PI : 0);
  if (style === "perpendicular") return roadHeading + (side * Math.PI) / 2;
  return roadHeading + side * (Math.PI / 2 - Math.PI / 4);
}

/** Place every occupied bay along one authored row. */
export function parkedCarsFromRow(row: ParkingRow): PlacedParkedCar[] {
  const coords = row.coords;
  if (!Array.isArray(coords) || coords.length < 2) return [];
  const lat0 = coords[0][1];
  const cos = Math.cos((lat0 * Math.PI) / 180);
  const x = (lon: number) => (lon - coords[0][0]) * METERS_PER_DEG_LON * cos;
  const y = (lat: number) => (lat - lat0) * METERS_PER_DEG_LAT;
  const pitch = Math.max(1, Number(row.pitch) || DEFAULT_PITCH);
  const occupancy = Math.min(
    100,
    Math.max(0, Number(row.occupancy ?? DEFAULT_OCCUPANCY)),
  );
  const side = Number(row.side) >= 0 ? 1 : -1;
  const style = row.style || "parallel";

  const segments: {
    ax: number;
    ay: number;
    bx: number;
    by: number;
    length: number;
    start: number;
  }[] = [];
  let total = 0;
  for (let i = 0; i + 1 < coords.length; i++) {
    const ax = x(coords[i][0]);
    const ay = y(coords[i][1]);
    const bx = x(coords[i + 1][0]);
    const by = y(coords[i + 1][1]);
    const length = Math.hypot(bx - ax, by - ay);
    if (length < 1e-6) continue;
    segments.push({ ax, ay, bx, by, length, start: total });
    total += length;
  }
  if (segments.length === 0 || total <= pitch) return [];

  const out: PlacedParkedCar[] = [];
  let distance = pitch / 2;
  let segment = 0;
  let bay = 0;
  while (distance < total - pitch / 2) {
    while (
      segment < segments.length - 1 &&
      segments[segment].start + segments[segment].length < distance
    ) {
      segment++;
    }
    const s = segments[segment];
    const fraction = (distance - s.start) / s.length;
    const px = s.ax + (s.bx - s.ax) * fraction;
    const py = s.ay + (s.by - s.ay) * fraction;
    const heading = Math.atan2(s.by - s.ay, s.bx - s.ax);
    const key = `${row.id ?? "row"}:${bay}`;
    if (hash(key) % 100 < occupancy) {
      out.push({
        lon: coords[0][0] + px / (METERS_PER_DEG_LON * cos),
        lat: lat0 + py / METERS_PER_DEG_LAT,
        heading: headingFor(heading, side, style),
      });
    }
    distance += pitch;
    bay++;
  }
  return out;
}

/** Place every car for a tile's authored parking rows. */
export function parkedCarsFromRows(rows: ParkingRow[]): PlacedParkedCar[] {
  const out: PlacedParkedCar[] = [];
  for (const row of rows) out.push(...parkedCarsFromRow(row));
  return out;
}
