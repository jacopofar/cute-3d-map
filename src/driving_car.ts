import * as THREE from "three";

import { toModelCoords } from "./projection";
import {
  DRIVE_CONFIG,
  driveStep,
  type DriveBlocked,
  type DriveConfig,
  type DriveInput,
  type DriveState,
} from "./driving";
import { CAR_TRAFFIC, vehicleGeometry } from "./traffic";

/*
 * The car of car mode: one mesh, placed every frame from the pure model in
 * driving.ts. It is lit like a parked car (so it darkens at night), but painted
 * a bright red so it is easy to find among the moving fleet. It is added to the
 * scene directly, not via loadedTiles, so a projection origin reset never
 * touches it: the state is lon/lat and the model coordinates are rebuilt from
 * the current origin each frame.
 */

const DRIVE_COLOR = 0xd7263d;

export class DrivingCar {
  private readonly mesh: THREE.Mesh;
  private state: DriveState = { lon: 0, lat: 0, heading: 0, speed: 0 };
  private active = false;

  constructor(scene: THREE.Scene) {
    // Lambert, not the moving fleet's unlit basic material: a driven car is a
    // foreground object and should follow the sun with the rest of the street
    const material = new THREE.MeshLambertMaterial({
      color: DRIVE_COLOR,
      vertexColors: true,
    });
    this.mesh = new THREE.Mesh(vehicleGeometry(CAR_TRAFFIC), material);
    this.mesh.userData = { kind: "driving_car" };
    this.mesh.visible = false;
    // the instance moves every frame; a bounding sphere from the start point
    // would cull it once the car drives away
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  get enabled(): boolean {
    return this.active;
  }

  get current(): DriveState {
    return { ...this.state };
  }

  start(lon: number, lat: number, heading: number): void {
    this.state = { lon, lat, heading, speed: 0 };
    this.active = true;
    this.mesh.visible = true;
  }

  stop(): void {
    this.active = false;
    this.mesh.visible = false;
  }

  /** Advance the model and redraw the body at the current origin. */
  update(
    input: DriveInput,
    dt: number,
    originMeters: [number, number],
    scaleFactor: number,
    blocked?: DriveBlocked,
    config: DriveConfig = DRIVE_CONFIG,
  ): DriveState {
    if (this.active) {
      this.state = driveStep(this.state, input, dt, config, blocked);
      this.place(originMeters, scaleFactor);
    }
    return this.current;
  }

  private place(originMeters: [number, number], scaleFactor: number): void {
    const [x, y] = toModelCoords(
      [this.state.lon, this.state.lat],
      originMeters,
      scaleFactor,
    );
    // the body is centered on its origin, so lift it by half its height to put
    // the wheels on the ground (same placement as the traffic renderer)
    this.mesh.position.set(x, y, CAR_TRAFFIC.height / 2);
    this.mesh.rotation.set(0, 0, this.state.heading);
  }
}
