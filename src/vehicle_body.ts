import * as THREE from "three";

/*
 * The body shared by the moving and parked cars: a low-poly car (chassis,
 * cabin, four wheels) and a boxy long body with a window band for trains.
 *
 * The geometry is built in the fleet's local space: X is the length, Y the
 * width, Z up, centered on the origin. The renderer places the mesh at
 * `height / 2`, so the bottom of the wheels sits on the ground.
 *
 * Vertex colors are the paint's base: three multiplies the vertex color by the
 * per-instance color, so the body stays near white (the instance color tints
 * it) while the glass and the wheels are nearly black (the paint barely shows
 * there). A box is 12 triangles, and parked cars are tens of thousands of
 * instances, so the car spends its budget carefully: 52 triangles, with the
 * invisible undersides and the wheels' caps left out.
 */

export type VehicleBodyKind = "car" | "train";

// the part of a fleet's config the body needs; TrafficFleetConfig extends it
export interface VehicleBodySize {
  length: number;
  width: number;
  height: number;
  body: VehicleBodyKind;
}

// near white, so the instance paint decides the color of the body
const BODY_COLOR = new THREE.Color("#f4f4f4");
// dark enough that a red or blue paint still reads as a dark window
const GLASS_COLOR = new THREE.Color("#1c242c");
const WHEEL_COLOR = new THREE.Color("#111214");

interface Rect {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
}

type Vec3 = [number, number, number];

// flat-shaded geometry accumulated as loose triangles; a car is small enough
// that an index buffer would only add indirection
class BodyBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];

  // a quad with the winding fixed from the expected outward normal. The faces
  // are hand-placed and a flipped one is invisible under backface culling, so
  // let the maths decide instead of trusting the corner order.
  private quad(
    a: Vec3,
    b: Vec3,
    c: Vec3,
    d: Vec3,
    color: THREE.Color,
    outward: Vec3,
  ): void {
    let normal = faceNormal(a, b, c);
    if (
      normal[0] * outward[0] + normal[1] * outward[1] + normal[2] * outward[2] <
      0
    ) {
      [b, d] = [d, b];
      normal = faceNormal(a, b, c);
    }
    this.triangle(a, b, c, normal, color);
    this.triangle(a, c, d, normal, color);
  }

  private triangle(
    a: Vec3,
    b: Vec3,
    c: Vec3,
    normal: Vec3,
    color: THREE.Color,
  ): void {
    for (const v of [a, b, c]) {
      this.positions.push(v[0], v[1], v[2]);
      this.normals.push(normal[0], normal[1], normal[2]);
      this.colors.push(color.r, color.g, color.b);
    }
  }

  // a rectangular block between two rectangles; equal rects give a plain box.
  // Caps are opt-in: the underside of the body and the cabin are never seen.
  block(
    bottom: Rect,
    top: Rect,
    z0: number,
    z1: number,
    color: THREE.Color,
    options: { top?: boolean; bottom?: boolean; topColor?: THREE.Color } = {},
  ): void {
    const b = [
      [bottom.cx - bottom.hx, bottom.cy - bottom.hy, z0],
      [bottom.cx + bottom.hx, bottom.cy - bottom.hy, z0],
      [bottom.cx + bottom.hx, bottom.cy + bottom.hy, z0],
      [bottom.cx - bottom.hx, bottom.cy + bottom.hy, z0],
    ] as Vec3[];
    const t = [
      [top.cx - top.hx, top.cy - top.hy, z1],
      [top.cx + top.hx, top.cy - top.hy, z1],
      [top.cx + top.hx, top.cy + top.hy, z1],
      [top.cx - top.hx, top.cy + top.hy, z1],
    ] as Vec3[];

    this.quad(b[0], b[1], t[1], t[0], color, [0, -1, 0]);
    this.quad(b[1], b[2], t[2], t[1], color, [1, 0, 0]);
    this.quad(b[2], b[3], t[3], t[2], color, [0, 1, 0]);
    this.quad(b[3], b[0], t[0], t[3], color, [-1, 0, 0]);
    if (options.top) {
      this.quad(t[0], t[1], t[2], t[3], options.topColor ?? color, [0, 0, 1]);
    }
    if (options.bottom) {
      this.quad(b[3], b[2], b[1], b[0], color, [0, 0, -1]);
    }
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(this.positions, 3),
    );
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(this.normals, 3),
    );
    geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(this.colors, 3),
    );
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

// 52 triangles: chassis 10 (four sides and the top), cabin 10 (four glass
// sides and the roof), four open-ended wheels at 8 each. The cabin sits on the
// chassis top and the wheels are tucked under it, so their hidden caps are the
// first thing to cut.
function carBody(size: VehicleBodySize): THREE.BufferGeometry {
  const builder = new BodyBuilder();
  const hx = size.length / 2;
  const hy = size.width / 2;
  const hz = size.height / 2;

  // the wheel radius sets the ride height: the wheels touch z = -hz and their
  // tops disappear inside the chassis, which keeps the look compact
  const wheelRadius = 0.27 * size.height;
  const wheelHalfWidth = 0.06 * size.width;
  const wheelCenterZ = -hz + wheelRadius;
  const wheelX = hx - wheelRadius - 0.04 * size.length;
  const wheelY = hy - wheelHalfWidth;

  const floorZ = -hz + 0.18 * size.height;
  const beltZ = -hz + 0.58 * size.height;

  // chassis: slightly narrower at the bottom (a hint of tumblehome) and with
  // no underside, which no camera at street level can see
  builder.block(
    { cx: 0, cy: 0, hx: hx - 0.05 * size.length, hy: hy - 0.06 * size.width },
    { cx: 0, cy: 0, hx, hy },
    floorZ,
    beltZ,
    BODY_COLOR,
    { top: true },
  );

  // cabin: inset glass house, shifted a touch rearward, with a body-colored
  // roof so a top-down view still reads as a car rather than a dark slab
  builder.block(
    {
      cx: -0.03 * size.length,
      cy: 0,
      hx: 0.27 * size.length,
      hy: 0.42 * size.width,
    },
    {
      cx: -0.03 * size.length,
      cy: 0,
      hx: 0.22 * size.length,
      hy: 0.36 * size.width,
    },
    beltZ,
    hz,
    GLASS_COLOR,
    { top: true, topColor: BODY_COLOR },
  );

  // open-ended wheel blocks: the four sides are enough, since the caps face
  // the chassis or the road
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      builder.block(
        {
          cx: sx * wheelX,
          cy: sy * wheelY,
          hx: wheelRadius,
          hy: wheelHalfWidth,
        },
        {
          cx: sx * wheelX,
          cy: sy * wheelY,
          hx: wheelRadius,
          hy: wheelHalfWidth,
        },
        wheelCenterZ - wheelRadius,
        wheelCenterZ + wheelRadius,
        WHEEL_COLOR,
      );
    }
  }

  return builder.build();
}

// trains stay a long box with a dark window band: a car's cabin and wheels
// would look wrong at 15 m, and there is no triangle pressure at 500 instances
function trainBody(size: VehicleBodySize): THREE.BufferGeometry {
  const builder = new BodyBuilder();
  const hx = size.length / 2;
  const hy = size.width / 2;
  const hz = size.height / 2;
  const skirtTop = -hz + 0.55 * size.height;
  const bandTop = -hz + 0.85 * size.height;

  builder.block(
    { cx: 0, cy: 0, hx, hy },
    { cx: 0, cy: 0, hx, hy },
    -hz,
    skirtTop,
    BODY_COLOR,
  );
  // the band sits a couple of centimeters inside the body, so its sides never
  // z-fight with the skirt and the roof
  builder.block(
    { cx: 0, cy: 0, hx: hx - 0.02, hy: hy - 0.02 },
    { cx: 0, cy: 0, hx: hx - 0.02, hy: hy - 0.02 },
    skirtTop,
    bandTop,
    GLASS_COLOR,
  );
  builder.block(
    { cx: 0, cy: 0, hx, hy },
    { cx: 0, cy: 0, hx, hy },
    bandTop,
    hz,
    BODY_COLOR,
    { top: true },
  );

  return builder.build();
}

/** The body for one fleet, in the fleet's dimensions. */
export function vehicleGeometry(size: VehicleBodySize): THREE.BufferGeometry {
  return size.body === "train" ? trainBody(size) : carBody(size);
}
