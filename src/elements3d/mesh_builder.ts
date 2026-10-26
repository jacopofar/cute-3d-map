import * as THREE from "three";

/*
 * A small accumulator for flat-shaded, vertex-colored geometry with per-quad
 * winding correction. Every procedural prop in `elements3d/` builds its mesh
 * through here: the boxes, the quads and the church/wall/vehicle shapes used to
 * each carry their own copy of "push six vertices, and if the cross product
 * points the wrong way swap two corners". That copy is easy to get subtly wrong
 * (a flipped face is invisible under backface culling) and it is the one place
 * where the attribute set has to stay consistent: every geometry of a kind is
 * merged into one mesh per tile, and `mergeGeometries` returns null on a
 * mismatched set, which drops the whole kind for that tile.
 */

export type Triple = [number, number, number];

export interface MeshBuilderOptions {
  /**
   * Emit a `uv` attribute. Off for geometries whose material is untextured and
   * whose siblings do not carry one either: an unused attribute is dead weight
   * in every merged vertex buffer.
   */
  uv?: boolean;
}

/**
 * Whether the triangle (a, b, c) faces away from `normal`. Two of its corners
 * have to be swapped to make it visible from that side.
 */
function facesAway(a: Triple, b: Triple, c: Triple, normal: Triple): boolean {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return nx * normal[0] + ny * normal[1] + nz * normal[2] < 0;
}

/** The unit normal of the triangle (a, b, c). */
function faceNormal(a: Triple, b: Triple, c: Triple): Triple {
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

export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] | undefined;
  private readonly colors: number[] = [];

  constructor(options: MeshBuilderOptions = {}) {
    this.uvs = options.uv === false ? undefined : [];
  }

  private vertex(
    p: Triple,
    n: Triple,
    uv: [number, number],
    color: THREE.Color,
  ): void {
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    this.uvs?.push(uv[0], uv[1]);
    this.colors.push(color.r, color.g, color.b);
  }

  /**
   * One triangle, flat shaded with the given outward normal, wound to face it.
   * The corner order is corrected for the same reason `quad` corrects it: a
   * hand-placed face that winds the wrong way is invisible under backface
   * culling, and that reads as a missing feature rather than a shading bug.
   */
  triangle(
    a: Triple,
    b: Triple,
    c: Triple,
    normal: Triple,
    color: THREE.Color,
  ): void {
    if (facesAway(b, c, a, normal)) [b, c] = [c, b];
    this.vertex(a, normal, [0, 0], color);
    this.vertex(b, normal, [1, 0], color);
    this.vertex(c, normal, [1, 1], color);
  }

  /**
   * A quad as two triangles, ordered so they face along `normal`. Three.js
   * culls back faces and the corner order of a hand-placed face is easy to get
   * wrong, so let the cross product decide instead of trusting the caller.
   */
  quad(
    a: Triple,
    b: Triple,
    c: Triple,
    d: Triple,
    normal: Triple,
    color: THREE.Color,
  ): void {
    if (facesAway(b, c, a, normal)) [b, d] = [d, b];
    this.vertex(a, normal, [0, 0], color);
    this.vertex(b, normal, [1, 0], color);
    this.vertex(c, normal, [1, 1], color);
    this.vertex(a, normal, [0, 0], color);
    this.vertex(c, normal, [1, 1], color);
    this.vertex(d, normal, [0, 1], color);
  }

  /**
   * A quad whose normal is derived from the corrected winding rather than
   * given: `outward` only says which side is outside. Use this when the face is
   * not axis-aligned (a tapered car body, a roof slope), where the true normal
   * is not the direction the caller can name.
   */
  quadFromOutward(
    a: Triple,
    b: Triple,
    c: Triple,
    d: Triple,
    outward: Triple,
    color: THREE.Color,
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

  /** A box with its base at `baseZ`, centered on (cx, cy), rotated by `angle`. */
  box(
    cx: number,
    cy: number,
    baseZ: number,
    width: number,
    depth: number,
    height: number,
    angle: number,
    color: THREE.Color,
  ): void {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const hx = width / 2;
    const hy = depth / 2;
    const hz = height / 2;
    const corner = (x: number, y: number, z: number): Triple => [
      cx + x * c - y * s,
      cy + x * s + y * c,
      baseZ + hz + z,
    ];
    const p000 = corner(-hx, -hy, -hz);
    const p100 = corner(hx, -hy, -hz);
    const p110 = corner(hx, hy, -hz);
    const p010 = corner(-hx, hy, -hz);
    const p001 = corner(-hx, -hy, hz);
    const p101 = corner(hx, -hy, hz);
    const p111 = corner(hx, hy, hz);
    const p011 = corner(-hx, hy, hz);
    const nx = c;
    const ny = s;
    // normals rotate with the box; the top/bottom stay on z
    this.quad(p000, p010, p110, p100, [0, 0, -1], color);
    this.quad(p001, p011, p111, p101, [0, 0, 1], color);
    this.quad(p000, p001, p101, p100, [ny, -nx, 0], color);
    this.quad(p010, p110, p111, p011, [-ny, nx, 0], color);
    this.quad(p000, p010, p011, p001, [-nx, -ny, 0], color);
    this.quad(p100, p101, p111, p110, [nx, ny, 0], color);
  }

  get isEmpty(): boolean {
    return this.positions.length === 0;
  }

  geometry(): THREE.BufferGeometry | null {
    if (this.positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(this.positions, 3),
    );
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(this.normals, 3),
    );
    if (this.uvs) {
      geometry.setAttribute(
        "uv",
        new THREE.Float32BufferAttribute(this.uvs, 2),
      );
    }
    geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(this.colors, 3),
    );
    return geometry;
  }
}
