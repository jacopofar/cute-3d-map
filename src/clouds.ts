import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";

/*
 * A decorative layer of cartoon clouds floating high above the tiles.
 *
 * Each cloud is a generated low-poly mesh — a handful of faceted spheres merged
 * into one lumpy cumulus — drawn with a translucent, flat-shaded material so the
 * overlapping blobs blend into a soft puff. Unlike a screen-space sprite it is
 * anchored in the world like the buildings: its position, its size and its
 * altitude are fixed in meters, so it scales with the zoom, slides with the pan
 * and shifts with the tilt, and it drifts with the wind at a fixed ground speed.
 *
 * The clouds tile an infinite sky (a torus): each cloud is drawn from whichever
 * copy of itself is nearest the map center, so panning anywhere always has sky
 * overhead without ever re-seeding, and a cloud only jumps to the next copy once
 * it is a full field away — off screen.
 *
 * Three variants of the mesh are shared across all the clouds (one instanced
 * draw call each), and each instance is turned and scaled a little differently.
 */

// clouds are not drawn at or above this zoom ...
export const CLOUD_MAX_ZOOM = 15;
// ... and are at full opacity at or below this one
export const CLOUD_FULL_ZOOM = 12;
const MAX_OPACITY = 0.62;

// Clouds sit on a jittered grid rather than at random positions: a random
// scatter clumps into a single white sheet, while a grid with one puff per cell
// keeps them reading as individual clouds.
const CLOUD_COLUMNS = 6;
const CLOUD_ROWS = 4;
const CLOUD_COUNT = CLOUD_COLUMNS * CLOUD_ROWS;
// distinct cloud shapes; the clouds are dealt out over them
const VARIANTS = 3;

// The sky repeats every FIELD_SIZE, in EPSG:3857 meters: a cloud is always
// drawn from whichever copy of itself is nearest the map center (see the torus
// note above). 42000 m is ~30 km of ground at Milan, wider than the view at the
// zooms the clouds are visible from, so the same copy is rarely seen twice.
const FIELD_SIZE = 42000;
// cloud width, in true meters, before the per-cloud scale below
const SIZE_METERS = 2400;
// altitude of the cloud base above the ground, in true meters: high enough to
// sit well clear of the buildings and give parallax when panning or pitching
const ALTITUDE_MIN = 900;
const ALTITUDE_MAX = 1900;
// wind: every cloud travels the same way, its speed varying a little. The speed
// is in EPSG:3857 meters per second (~0.7x that many true meters at Milan), and
// slow enough that a cloud takes minutes to cross the view.
const WIND_BEARING = 70; // degrees clockwise from north, the way the wind blows
const WIND_SPEED = 26;

// where the camera is looking: clouds need the map center, in EPSG:3857 meters,
// to pick the nearest copy, plus the zoom for the fade and the time to drift
export interface View {
  zoom: number;
  center: [number, number];
  now: number;
}

interface Cloud {
  x: number; // EPSG:3857 meters, kept inside [0, FIELD_SIZE)
  y: number;
  vx: number; // EPSG:3857 meters per second
  vy: number;
  scale: number;
  altitude: number; // true meters
  // baked orientation around the vertical, so identical shapes do not stack up
  spin: THREE.Quaternion;
  variant: number;
  slot: number;
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const DEG2RAD = Math.PI / 180;

// cloud tints for the day/night model; the material color is lerped between
// them so a night sky reads as dark grey-blue rather than white
const DAY_CLOUD = new THREE.Color(0xffffff);
const NIGHT_CLOUD = new THREE.Color(0x36415e);

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function wrap(x: number, size: number): number {
  return ((x % size) + size) % size;
}

// One cloud shape: a few low-poly spheres (icosahedra, so the facets read as
// hand-cut) merged into a lumpy mass, flattened and normalized so its width is
// 1 and its base sits on z = 0 — the instance scale is then its width in meters.
function cloudGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const blobs = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < blobs; i++) {
    const radius = 0.24 + Math.random() * 0.18;
    const sphere = new THREE.IcosahedronGeometry(radius, 1);
    sphere.translate(
      (Math.random() - 0.5) * 0.8,
      (Math.random() - 0.5) * 0.8,
      0.2 + Math.random() * 0.35,
    );
    parts.push(sphere);
  }
  const merged = BufferGeometryUtils.mergeGeometries(parts);
  if (!merged) return new THREE.IcosahedronGeometry(0.6, 1);
  merged.computeBoundingBox();
  const box = merged.boundingBox;
  if (box) {
    const width = Math.max(box.max.x - box.min.x, box.max.y - box.min.y);
    merged.translate(
      -(box.min.x + box.max.x) / 2,
      -(box.min.y + box.max.y) / 2,
      -box.min.z,
    );
    merged.scale(1 / width, 1 / width, 1 / width);
  }
  return merged;
}

export class CloudLayer {
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly material: THREE.MeshStandardMaterial;
  private readonly dummy = new THREE.Object3D();
  private readonly clouds: Cloud[] = [];
  private enabled = true;
  // ms timestamp of the last update, to advance the drift by real time
  private lastUpdate?: number;

  constructor(scene: THREE.Scene) {
    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      // a little self-illumination so the shaded facets stay white rather than
      // turning gray under the tone mapping
      emissive: 0xdfe8ff,
      emissiveIntensity: 0.22,
      // facets, so the low-poly blobs read as cartoon cloud lumps
      flatShading: true,
      transparent: true,
      opacity: 0, // set from the zoom in update()
      // clouds blend into each other instead of punching holes in one another
      depthWrite: false,
      roughness: 1,
      metalness: 0,
    });

    const perVariant: number[][] = Array.from({ length: VARIANTS }, () => []);
    const wind = WIND_BEARING * DEG2RAD;
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const column = i % CLOUD_COLUMNS;
      const row = Math.floor(i / CLOUD_COLUMNS);
      const speed = WIND_SPEED * (0.6 + Math.random() * 0.8);
      const variant = i % VARIANTS;
      const slot = perVariant[variant].length;
      perVariant[variant].push(i);
      this.clouds.push({
        // jitter across the whole cell, so the grid is not visible (and a cell
        // can land on the map center, unlike a cell-center-only layout)
        x: ((column + Math.random()) / CLOUD_COLUMNS) * FIELD_SIZE,
        y: ((row + Math.random()) / CLOUD_ROWS) * FIELD_SIZE,
        vx: speed * Math.sin(wind),
        vy: speed * Math.cos(wind),
        scale: 0.7 + Math.random() * 0.8,
        altitude: ALTITUDE_MIN + Math.random() * (ALTITUDE_MAX - ALTITUDE_MIN),
        spin: new THREE.Quaternion().setFromAxisAngle(
          Z_AXIS,
          Math.random() * Math.PI * 2,
        ),
        variant,
        slot,
      });
    }

    for (let v = 0; v < VARIANTS; v++) {
      const mesh = new THREE.InstancedMesh(
        cloudGeometry(),
        this.material,
        perVariant[v].length,
      );
      this.clouds.forEach((cloud) => {
        if (cloud.variant !== v) return;
        // slight variation in whiteness, so a bank of clouds reads as depth
        const shade = 0.9 + Math.random() * 0.1;
        mesh.setColorAt(cloud.slot, new THREE.Color(shade, shade, 1));
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // the instances move (and the whole sky rescales with the zoom), so
      // frustum culling against stale bounds would hide them
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.meshes.push(mesh);
      scene.add(mesh);
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  // Tint the clouds for the night: dim and cool, so they do not glow white over
  // a dark city. `night` is the 0..1 factor from the day/night model.
  setNight(night: number): void {
    this.material.color.copy(DAY_CLOUD).lerp(NIGHT_CLOUD, night);
    this.material.emissiveIntensity = 0.22 * (1 - 0.8 * night);
  }

  // originMeters/scaleFactor are the same projection origin the tiles and the
  // fleets use; view describes where the camera is looking
  update(
    originMeters: [number, number],
    scaleFactor: number,
    view: View,
  ): void {
    const opacity = this.enabled
      ? MAX_OPACITY *
        clamp01(
          (CLOUD_MAX_ZOOM - view.zoom) / (CLOUD_MAX_ZOOM - CLOUD_FULL_ZOOM),
        )
      : 0;
    this.material.opacity = opacity;
    const visible = opacity > 0.01;
    for (const mesh of this.meshes) mesh.visible = visible;
    if (!visible) {
      // drop the timestamp so the drift resumes smoothly when they return
      this.lastUpdate = undefined;
      return;
    }

    const dt =
      this.lastUpdate === undefined
        ? 0
        : Math.min((view.now - this.lastUpdate) / 1000, 0.5);
    this.lastUpdate = view.now;

    const [centerX, centerY] = view.center;
    for (let i = 0; i < this.clouds.length; i++) {
      const cloud = this.clouds[i];
      cloud.x = wrap(cloud.x + cloud.vx * dt, FIELD_SIZE);
      cloud.y = wrap(cloud.y + cloud.vy * dt, FIELD_SIZE);
      // the copy of the cloud nearest the map center: this is what makes the
      // sky seamless across the torus
      const worldX =
        cloud.x + FIELD_SIZE * Math.round((centerX - cloud.x) / FIELD_SIZE);
      const worldY =
        cloud.y + FIELD_SIZE * Math.round((centerY - cloud.y) / FIELD_SIZE);
      const size = SIZE_METERS * cloud.scale;
      this.dummy.position.set(
        (worldX - originMeters[0]) * scaleFactor,
        (worldY - originMeters[1]) * scaleFactor,
        cloud.altitude,
      );
      this.dummy.quaternion.copy(cloud.spin);
      this.dummy.scale.set(size, size, size);
      this.dummy.updateMatrix();
      this.meshes[cloud.variant].setMatrixAt(cloud.slot, this.dummy.matrix);
    }
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
  }
}
