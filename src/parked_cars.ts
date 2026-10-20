import * as THREE from "three";

import { toModelCoords, type ParkedCar } from "./geojson_data";
import { CAR_TRAFFIC, vehicleGeometry } from "./traffic";

/*
 * Static parked cars along the roads, drawn with the moving cars' body.
 *
 * tilegen places the bays (parallel, perpendicular or fishbone) and emits the
 * occupied ones as [lon, lat, heading] in the tile's `parking` block. This layer
 * rebuilds one InstancedMesh from the tiles around the centre. It has no
 * per-frame work at all: the cars never move, so the matrices are written when
 * the loaded set or the projection origin changes.
 *
 * Like the facade detail it only exists above FACADE_MIN_ZOOM, and only for the
 * tiles around the centre: the fully loaded window is seven tiles across, which
 * would be hundreds of thousands of cars, almost all off-screen.
 */

// the same gate as the building windows (FACADE_MIN_ZOOM in main.ts)
export const PARKED_CAR_MIN_ZOOM = 17;

// plausible parked-car paint, with plenty of white/silver/gray
const PARKED_COLORS = [
  0xf2f2f2, 0xd9d9d9, 0xb8bcc1, 0x9aa0a6, 0x6b7280, 0x3d4350, 0x1f2933,
  0x8b1e1e, 0x1e4d8b, 0x2e7d5b, 0xb58a2a, 0xe8e2d6,
];

// a stable color from the car's position, so rebuilding the layer does not
// reshuffle the paint
function parkedColor(lon: number, lat: number): number {
  const hash =
    (Math.imul(Math.round(lon * 1e6), 73856093) ^
      Math.imul(Math.round(lat * 1e6), 19349663)) >>>
    0;
  return PARKED_COLORS[hash % PARKED_COLORS.length];
}

/**
 * One instanced mesh for the parked cars of the tiles around the centre. The
 * body and dimensions are the moving cars' (CAR_TRAFFIC), so the two layers read
 * as the same vehicle.
 */
export class ParkedCarLayer {
  private readonly mesh: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  private readonly capacity: number;
  private spots: ParkedCar[] = [];
  private enabled = true;

  constructor(scene: THREE.Scene, capacity = 120_000) {
    this.capacity = Math.max(1, capacity);
    // Lambert, not the moving fleet's unlit basic material: parked cars follow
    // the sun and go dark at night, while the moving cars stay bright.
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(
      vehicleGeometry(CAR_TRAFFIC),
      material,
      this.capacity,
    );
    this.mesh.count = 0;
    // the instance set changes as tiles/centre change, so a stale bounding
    // sphere would cull it wrongly; one draw call is cheap enough anyway
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    // so the e2e can find the layer
    this.mesh.userData = { kind: "parked_car" };
    scene.add(this.mesh);
  }

  get count(): number {
    return this.mesh.count;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.mesh.visible = enabled;
  }

  // the cars for the current centre and origin. Rebuilt only when that set or
  // the origin changes, never per frame.
  setSpots(
    spots: ParkedCar[],
    originMeters: [number, number],
    scaleFactor: number,
  ): void {
    this.spots = spots;
    const count = Math.min(spots.length, this.capacity);
    for (let i = 0; i < count; i++) {
      const spot = spots[i];
      const m = toModelCoords([spot.lon, spot.lat], originMeters, scaleFactor);
      this.dummy.position.set(m[0], m[1], CAR_TRAFFIC.height / 2);
      this.dummy.rotation.set(0, 0, spot.heading);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, new THREE.Color(parkedColor(spot.lon, spot.lat)));
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (spots.length > this.capacity) {
      console.warn(
        `parked cars: ${spots.length} exceed the ${this.capacity} instance capacity`,
      );
    }
  }
}
