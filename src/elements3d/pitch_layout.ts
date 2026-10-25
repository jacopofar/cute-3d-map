// The paint of a sports pitch, as maths: fit the sport's real field proportions
// into the mapped footprint (aligned to its principal axis), then lay the
// markings out in that frame. Pure and unit-tested like the lane and roof
// layouts; `pitch.ts` turns the segments into geometry and raises the goal
// frames, hoops and nets.

export interface Segment {
  a: [number, number];
  b: [number, number];
}

export interface PitchFrame {
  centre: [number, number];
  /** unit vector down the pitch's length */
  along: [number, number];
  /** unit vector across it */
  across: [number, number];
  /** model meters per field meter */
  scale: number;
  /** the field the paint is laid out on, in its own meters */
  length: number;
  width: number;
}

// The real field, in meters. The paint is scaled to the footprint, so a 30 m
// five-a-side gets the same layout as a 105 m pitch, and a court mapped at an
// angle still lines up.
const FIELDS: Record<string, [number, number]> = {
  soccer: [105, 68],
  futsal: [40, 20],
  "five-a-side": [40, 20],
  tennis: [23.77, 10.97],
  padel: [20, 10],
  basketball: [28, 15],
  // a multi-use court is drawn as the basketball one: hoops and all
  multi: [28, 15],
  volleyball: [18, 9],
  beachvolleyball: [16, 8],
  // a 400 m track: 84.39 m straights, 36.5 m inner radius, 8 lanes of 1.22 m
  athletics: [176.91, 92.52],
};

// How long the drawn field has to be to be worth painting, in meters. A
// throwing area or a warm-up strip tagged `athletics` is not a track, and a
// 20 m oval with eight lanes reads as scribble.
const MIN_DRAWN_LENGTH: Record<string, number> = { athletics: 80 };

// OSM sometimes draws the pitch with its run-off and sometimes just the playing
// surface; a meter of margin keeps the paint off the polygon edge either way.
export const PITCH_MARGIN = 1.0;

// below this the footprint is too small to be a pitch at all
const MIN_SCALE = 0.05;

export const PITCH_SPORTS = Object.keys(FIELDS);

// `sport` can be a ";" list; the first entry with a layout wins
export function pitchSportOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  for (const part of value.split(";")) {
    const sport = part.trim().toLowerCase();
    if (sport in FIELDS) return sport;
  }
  return null;
}

/**
 * Fit the sport's field inside a footprint, centred on it and aligned to its
 * principal axis. Null when there is no layout for the sport or the footprint is
 * degenerate.
 */
export function pitchFrame(
  ring: readonly [number, number][],
  sport: string,
): PitchFrame | null {
  const field = FIELDS[sport];
  if (!field || ring.length < 4) return null;

  // The footprint's own long axis, from its minimum-area bounding rectangle:
  // OSM maps pitches as rotated rectangles, and a PCA over the ring's vertices
  // is pulled off-axis by the closing duplicate point (0.3 degrees on a plain
  // 12 x 30 box, enough to tilt every line). Trying each edge direction is exact
  // for a rectangle, and a pitch ring is a handful of points.
  let best: {
    area: number;
    along: [number, number];
    across: [number, number];
    minU: number;
    maxU: number;
    minV: number;
    maxV: number;
  } | null = null;
  for (let i = 0; i < ring.length - 1; i++) {
    const dx = ring[i + 1][0] - ring[i][0];
    const dy = ring[i + 1][1] - ring[i][1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    const ax = dx / length;
    const ay = dy / length;
    for (const along of [
      [ax, ay],
      [-ay, ax],
    ] as [number, number][]) {
      const across: [number, number] = [-along[1], along[0]];
      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      for (const [x, y] of ring) {
        const u = x * along[0] + y * along[1];
        const v = x * across[0] + y * across[1];
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
      const area = (maxU - minU) * (maxV - minV);
      if (best === null || area < best.area) {
        best = { area, along, across, minU, maxU, minV, maxV };
      }
    }
  }
  if (best === null) return null;

  // the field runs down the longer side of that rectangle
  const longU = best.maxU - best.minU >= best.maxV - best.minV;
  const along = longU ? best.along : best.across;
  const across = longU ? best.across : best.along;
  const minU = longU ? best.minU : best.minV;
  const maxU = longU ? best.maxU : best.maxV;
  const minV = longU ? best.minV : best.minU;
  const maxV = longU ? best.maxV : best.maxU;

  const availableLength = maxU - minU - 2 * PITCH_MARGIN;
  const availableWidth = maxV - minV - 2 * PITCH_MARGIN;
  if (availableLength <= 1 || availableWidth <= 1) return null;
  const scale = Math.min(availableLength / field[0], availableWidth / field[1]);
  if (!Number.isFinite(scale) || scale <= MIN_SCALE) return null;
  if (field[0] * scale < (MIN_DRAWN_LENGTH[sport] ?? 0)) return null;

  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;
  return {
    centre: [along[0] * cu + across[0] * cv, along[1] * cu + across[1] * cv],
    along,
    across,
    scale,
    length: field[0],
    width: field[1],
  };
}

// a point of the field, in field meters from its centre
export function pitchPoint(
  frame: PitchFrame,
  u: number,
  v: number,
): [number, number] {
  return [
    frame.centre[0] + (frame.along[0] * u + frame.across[0] * v) * frame.scale,
    frame.centre[1] + (frame.along[1] * u + frame.across[1] * v) * frame.scale,
  ];
}

function line(
  frame: PitchFrame,
  u1: number,
  v1: number,
  u2: number,
  v2: number,
): Segment {
  return { a: pitchPoint(frame, u1, v1), b: pitchPoint(frame, u2, v2) };
}

function rect(
  frame: PitchFrame,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
): Segment[] {
  return [
    line(frame, u0, v0, u1, v0),
    line(frame, u1, v0, u1, v1),
    line(frame, u1, v1, u0, v1),
    line(frame, u0, v1, u0, v0),
  ];
}

function circle(
  frame: PitchFrame,
  cu: number,
  cv: number,
  radius: number,
  steps = 24,
): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < steps; i++) {
    const a0 = (i / steps) * Math.PI * 2;
    const a1 = ((i + 1) / steps) * Math.PI * 2;
    out.push(
      line(
        frame,
        cu + Math.cos(a0) * radius,
        cv + Math.sin(a0) * radius,
        cu + Math.cos(a1) * radius,
        cv + Math.sin(a1) * radius,
      ),
    );
  }
  return out;
}

function arc(
  frame: PitchFrame,
  cu: number,
  cv: number,
  radius: number,
  from: number,
  to: number,
  steps = 16,
): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < steps; i++) {
    const a0 = from + ((to - from) * i) / steps;
    const a1 = from + ((to - from) * (i + 1)) / steps;
    out.push(
      line(
        frame,
        cu + Math.cos(a0) * radius,
        cv + Math.sin(a0) * radius,
        cu + Math.cos(a1) * radius,
        cv + Math.sin(a1) * radius,
      ),
    );
  }
  return out;
}

// A stadium (the shape of a running track): two straights and a half circle at
// each end. Every lane shares the straights' ends, so only the radius grows.
function stadium(
  frame: PitchFrame,
  halfStraight: number,
  radius: number,
  steps = 12,
): Segment[] {
  return [
    line(frame, -halfStraight, radius, halfStraight, radius),
    line(frame, -halfStraight, -radius, halfStraight, -radius),
    ...arc(frame, halfStraight, 0, radius, -Math.PI / 2, Math.PI / 2, steps),
    ...arc(
      frame,
      -halfStraight,
      0,
      radius,
      Math.PI / 2,
      (3 * Math.PI) / 2,
      steps,
    ),
  ];
}

/**
 * The markings of one pitch, in model space. Every layout starts from the outer
 * line of the field; the goal frames, hoops and nets are `pitch.ts`'s job.
 */
export function pitchPaint(sport: string, frame: PitchFrame): Segment[] {
  const length = frame.length / 2;
  const width = frame.width / 2;
  // a track is an oval: its lane outlines are the boundary, so no rectangle
  const out =
    sport === "athletics" ? [] : rect(frame, -length, -width, length, width);

  if (sport === "soccer") {
    // halfway line and centre circle (9.15 m, FIFA)
    out.push(line(frame, 0, -width, 0, width));
    out.push(...circle(frame, 0, 0, 9.15));
    // penalty area 16.5 x 40.32 and goal area 5.5 x 18.32, at both ends
    for (const end of [-1, 1]) {
      const goalLine = end * length;
      out.push(...rect(frame, goalLine, -20.16, goalLine - end * 16.5, 20.16));
      out.push(...rect(frame, goalLine, -9.16, goalLine - end * 5.5, 9.16));
    }
  }

  if (sport === "futsal" || sport === "five-a-side") {
    // halfway, a 3 m centre circle and the 6 m "D" in front of each goal
    out.push(line(frame, 0, -width, 0, width));
    out.push(...circle(frame, 0, 0, 3));
    for (const end of [-1, 1]) {
      const goal = end * length;
      out.push(
        ...arc(
          frame,
          goal,
          0,
          6,
          end < 0 ? -Math.PI / 2 : Math.PI / 2,
          end < 0 ? Math.PI / 2 : (3 * Math.PI) / 2,
          12,
        ),
      );
    }
  }

  if (sport === "padel") {
    // the net, a service line 3 m into each side, and the centre line joining
    // them: the walls are mapped as ways, so the box is the paint's job
    out.push(line(frame, 0, -width, 0, width));
    for (const end of [-1, 1]) {
      out.push(line(frame, end * 3, -width, end * 3, width));
      out.push(line(frame, 0, 0, end * 3, 0));
    }
  }

  if (sport === "tennis") {
    // the outer line is the doubles court; singles sidelines 1.37 m in
    const singles = 4.115;
    out.push(line(frame, -length, singles, length, singles));
    out.push(line(frame, -length, -singles, length, -singles));
    // service lines 6.4 m from the net, joined across the middle
    out.push(line(frame, -6.4, -singles, -6.4, singles));
    out.push(line(frame, 6.4, -singles, 6.4, singles));
    out.push(line(frame, -6.4, 0, 6.4, 0));
    // the net itself is a mesh, but its line is paint like the rest
    out.push(line(frame, 0, -width, 0, width));
  }

  if (sport === "basketball" || sport === "multi") {
    out.push(line(frame, 0, -width, 0, width));
    out.push(...circle(frame, 0, 0, 1.8));
    for (const end of [-1, 1]) {
      const baseline = end * length;
      // the key: 4.9 m deep, 5.8 m wide, with the free-throw circle on its edge
      const freeThrow = baseline - end * 4.9;
      out.push(...rect(frame, baseline, -2.9, freeThrow, 2.9));
      out.push(...arc(frame, freeThrow, 0, 1.8, 0, Math.PI * 2, 16));
      // the three-point line: two straights from the baseline, then the arc
      const hoop = baseline - end * 1.575;
      const side = width - 0.9;
      const meet = Math.sqrt(Math.max(0, 6.75 * 6.75 - side * side));
      out.push(
        line(frame, baseline, side * end, hoop + end * meet, side * end),
      );
      out.push(
        line(frame, baseline, -side * end, hoop + end * meet, -side * end),
      );
      const from = Math.atan2(side, meet);
      const to = Math.PI - from;
      out.push(
        ...arc(
          frame,
          hoop,
          0,
          6.75,
          end > 0 ? -to : to,
          end > 0 ? -from : from,
        ),
      );
    }
  }

  if (sport === "volleyball") {
    // centre line and the attack lines 3 m either side
    out.push(line(frame, 0, -width, 0, width));
    out.push(line(frame, -3, -width, -3, width));
    out.push(line(frame, 3, -width, 3, width));
  }
  // beach volleyball paints its boundary and nothing else: the net divides the
  // sand and there is no attack line to draw

  if (sport === "athletics") {
    // Nine stadium outlines: the inner kerb, the seven lane dividers and the
    // outer edge. The straights all end on the same two lines, so only the
    // radius grows from the 36.5 m kerb to the 46.26 m outer edge.
    const halfStraight = length - width;
    const innerRadius = 36.5;
    const lanes = 8;
    const laneWidth = (width - innerRadius) / lanes;
    for (let lane = 0; lane <= lanes; lane++) {
      out.push(...stadium(frame, halfStraight, innerRadius + lane * laneWidth));
    }
    // the finish line, across the track at the end of the home straight
    out.push(line(frame, halfStraight, -innerRadius, halfStraight, -width));
  }

  return out;
}
