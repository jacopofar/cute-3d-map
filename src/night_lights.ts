import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";

import { toModelCoords } from "./geojson_data";
import { lightGreen, SIGNAL_GREEN_S } from "./traffic_math";

/*
 * Night lights: the warm street lamps and the red/green signal heads.
 *
 * Both are decorative point lights drawn as additive glow sprites, one draw call
 * each. The signal colors follow the same global 8 s light as the vehicle speed
 * bumps (each signal gets a stable axis from its position), so the city blinks
 * red/green in sync with the traffic instead of being random decoration.
 *
 * A thin instanced post grounds each glow; it is visible during the day too, but
 * the glows only switch on at night and above NIGHT_LIGHT_MIN_ZOOM.
 */

export const NIGHT_LIGHT_MIN_ZOOM = 15;

const LAMP_COLORS = [0xffd9a4, 0xffe4bd, 0xffcf8f, 0xffe9c9];
const RED = new THREE.Color("#ff4438");
const GREEN = new THREE.Color("#43ff86");

let sharedGlow: THREE.Texture | undefined;

function glowTexture(): THREE.Texture {
  if (sharedGlow) return sharedGlow;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.22, "rgba(255,255,255,0.72)");
    gradient.addColorStop(0.55, "rgba(255,255,255,0.18)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  sharedGlow = new THREE.CanvasTexture(canvas);
  sharedGlow.colorSpace = THREE.SRGBColorSpace;
  return sharedGlow;
}

export interface NightSpot {
  lon: number;
  lat: number;
}

function hashSpot(lon: number, lat: number): number {
  return (
    (Math.imul(Math.round(lon * 1e6), 73856093) ^
      Math.imul(Math.round(lat * 1e6), 19349663)) >>>
    0
  );
}

function points(
  positions: Array<[number, number, number]>,
  colors: Float32Array,
  size: number,
  opacity = 1,
): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions.flat(), 3),
  );
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size,
    map: glowTexture(),
    vertexColors: true,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
    alphaTest: 0.01,
  });
  const result = new THREE.Points(geometry, material);
  // the set is rebuilt as tiles/centre change, so stale bounds would cull it
  result.frustumCulled = false;
  return result;
}

/** The warm lamps and the signal heads for the tiles around the centre. */
export class NightLights {
  private readonly scene: THREE.Scene;
  private lamps?: THREE.Points;
  private lampPools?: THREE.Points;
  private signals?: THREE.Points;
  private readonly posts: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  private readonly capacity: number;
  private signalAxes: number[] = [];
  private phase = -1;

  constructor(scene: THREE.Scene, capacity = 80_000) {
    this.scene = scene;
    this.capacity = Math.max(1, capacity);
    // pole + a small head, so the glows sit on something instead of floating
    const pole = new THREE.BoxGeometry(0.16, 0.16, 4.2);
    pole.translate(0, 0, 2.1);
    const head = new THREE.BoxGeometry(0.5, 0.5, 0.22);
    head.translate(0, 0, 4.2);
    const geometry = BufferGeometryUtils.mergeGeometries([pole, head]);
    const material = new THREE.MeshBasicMaterial({ color: 0x1d2128 });
    this.posts = new THREE.InstancedMesh(
      geometry ?? pole,
      material,
      this.capacity,
    );
    this.posts.count = 0;
    this.posts.frustumCulled = false;
    this.posts.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.posts.userData = { kind: "night_lights" };
    scene.add(this.posts);
  }

  // the union of the centre tiles' lamps and signals, rebuilt only when that
  // set or the projection origin changes
  setSpots(
    lamps: NightSpot[],
    signals: NightSpot[],
    originMeters: [number, number],
    scaleFactor: number,
  ): void {
    this.disposePoints();
    const lampPositions: Array<[number, number, number]> = [];
    const lampColors = new Float32Array(lamps.length * 3);
    const color = new THREE.Color();
    for (let i = 0; i < lamps.length; i++) {
      const m = toModelCoords(
        [lamps[i].lon, lamps[i].lat],
        originMeters,
        scaleFactor,
      );
      lampPositions.push([m[0], m[1], 4.35]);
      color.setHex(
        LAMP_COLORS[hashSpot(lamps[i].lon, lamps[i].lat) % LAMP_COLORS.length],
      );
      lampColors[i * 3] = color.r;
      lampColors[i * 3 + 1] = color.g;
      lampColors[i * 3 + 2] = color.b;
    }
    if (lamps.length > 0) {
      this.lamps = points(lampPositions, lampColors, 10);
      this.scene.add(this.lamps);
      // a wider, dimmer billboard at ground level: the lamp's pool of light
      const pools = lampPositions.map(
        ([x, y]) => [x, y, 0.25] as [number, number, number],
      );
      this.lampPools = points(pools, lampColors.slice(), 18, 0.32);
      this.scene.add(this.lampPools);
      lampPositions.length = 0;
    }

    const signalPositions: Array<[number, number, number]> = [];
    const signalColors = new Float32Array(signals.length * 3);
    this.signalAxes = [];
    for (let i = 0; i < signals.length; i++) {
      const m = toModelCoords(
        [signals[i].lon, signals[i].lat],
        originMeters,
        scaleFactor,
      );
      signalPositions.push([m[0], m[1], 4.35]);
      this.signalAxes.push(hashSpot(signals[i].lon, signals[i].lat) % 2);
    }
    if (signals.length > 0) {
      this.signals = points(signalPositions, signalColors, 9);
      this.scene.add(this.signals);
      this.phase = -1;
    }

    // one post per light, plus the signals, in a single instanced draw
    const total = Math.min(this.capacity, lamps.length + signals.length);
    let slot = 0;
    for (const spot of [...lamps, ...signals]) {
      if (slot >= total) break;
      const m = toModelCoords([spot.lon, spot.lat], originMeters, scaleFactor);
      this.dummy.position.set(m[0], m[1], 0);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.posts.setMatrixAt(slot, this.dummy.matrix);
      slot++;
    }
    this.posts.count = slot;
    this.posts.instanceMatrix.needsUpdate = true;
    this.update(performance.now() / 1000);
  }

  setVisible(night: number, zoom: number): void {
    const detailed = zoom >= NIGHT_LIGHT_MIN_ZOOM;
    const dark = night > 0.2;
    if (this.lamps) this.lamps.visible = detailed && dark;
    if (this.lampPools) this.lampPools.visible = detailed && dark;
    if (this.signals) this.signals.visible = detailed && dark;
    this.posts.visible = detailed;
  }

  // the signal heads follow the same global light as the traffic speed bumps
  update(now: number): void {
    if (!this.signals || this.signalAxes.length === 0) return;
    const phase = Math.floor(now / SIGNAL_GREEN_S);
    if (phase === this.phase) return;
    this.phase = phase;
    const colors = this.signals.geometry.getAttribute("color");
    for (let i = 0; i < this.signalAxes.length; i++) {
      const color = lightGreen(this.signalAxes[i], now) ? GREEN : RED;
      colors.setXYZ(i, color.r, color.g, color.b);
    }
    colors.needsUpdate = true;
  }

  private disposePoints(): void {
    for (const points of [this.lamps, this.lampPools, this.signals]) {
      if (!points) continue;
      points.geometry.dispose();
      (points.material as THREE.Material).dispose();
      points.removeFromParent();
    }
    this.lamps = undefined;
    this.lampPools = undefined;
    this.signals = undefined;
  }
}
