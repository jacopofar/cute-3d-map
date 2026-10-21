import * as THREE from "three";

/*
 * A small accumulator for low-poly boxes with vertex colors, shared by the
 * cemetery tombstones and the street furniture. Each box is 12 triangles, with
 * its own positions/normals/uvs/color so many props can be merged into one
 * per-tile mesh. Faces are wind-corrected from the expected outward normal, so
 * callers do not have to get the corner order right.
 */

type Triple = [number, number, number];

interface Buffers {
  position: number[];
  normal: number[];
  uv: number[];
  color: number[];
}

function pushVertex(
  buffers: Buffers,
  p: Triple,
  n: Triple,
  uv: [number, number],
  color: THREE.Color,
): void {
  buffers.position.push(p[0], p[1], p[2]);
  buffers.normal.push(n[0], n[1], n[2]);
  buffers.uv.push(uv[0], uv[1]);
  buffers.color.push(color.r, color.g, color.b);
}

function pushQuad(
  buffers: Buffers,
  a: Triple,
  b: Triple,
  c: Triple,
  d: Triple,
  normal: Triple,
  color: THREE.Color,
): void {
  const e1: Triple = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2: Triple = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross: Triple = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  if (cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2] < 0) {
    [b, d] = [d, b];
  }
  pushVertex(buffers, a, normal, [0, 0], color);
  pushVertex(buffers, b, normal, [1, 0], color);
  pushVertex(buffers, c, normal, [1, 1], color);
  pushVertex(buffers, a, normal, [0, 0], color);
  pushVertex(buffers, c, normal, [1, 1], color);
  pushVertex(buffers, d, normal, [0, 1], color);
}

export class BoxBuilder {
  private readonly buffers: Buffers = {
    position: [],
    normal: [],
    uv: [],
    color: [],
  };

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
    pushQuad(this.buffers, p000, p010, p110, p100, [0, 0, -1], color);
    pushQuad(this.buffers, p001, p011, p111, p101, [0, 0, 1], color);
    pushQuad(this.buffers, p000, p001, p101, p100, [ny, -nx, 0], color);
    pushQuad(this.buffers, p010, p110, p111, p011, [-ny, nx, 0], color);
    pushQuad(this.buffers, p000, p010, p011, p001, [-nx, -ny, 0], color);
    pushQuad(this.buffers, p100, p101, p111, p110, [nx, ny, 0], color);
  }

  geometry(): THREE.BufferGeometry | null {
    const buffers = this.buffers;
    if (buffers.position.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(buffers.position, 3),
    );
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(buffers.normal, 3),
    );
    geometry.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute(buffers.uv, 2),
    );
    geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(buffers.color, 3),
    );
    return geometry;
  }
}
