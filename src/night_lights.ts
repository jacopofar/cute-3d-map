import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";

import { toModelCoords } from "./projection";
import type { LampSpot } from "./geojson_data";
import { lightGreen, SIGNAL_GREEN_S } from "./traffic_math";

/*
 * Night lights: the warm street lamps and the red/green signal heads.
 *
 * Both are decorative point lights drawn as additive glow sprites. The signal
 * colors follow the same global 8 s light as the vehicle speed bumps (each
 * signal gets a stable axis from its position), so the city blinks red/green in
 * sync with the traffic instead of being random decoration.
 *
 * One Points/InstancedMesh per tile and layer, diffed like the parked cars: a
 * tile that enters the 3x3 centre window is built, one that leaves is disposed,
 * and one that stayed with the same spot arrays is untouched. The layers are
 * only a few draws each and the sprites are additive, so the extra draw calls
 * are cheaper than rebuilding every lamp on a one-tile pan.
 *
 * A thin instanced post grounds each glow; it is visible during the day too, but
 * the glows only switch on at night and above NIGHT_LIGHT_MIN_ZOOM.
 */

export const NIGHT_LIGHT_MIN_ZOOM = 15;

const LAMP_COLORS = [
  0xffd9a4, 0xffe4bd, 0xffcf8f, 0xffe9c9, 0xff9a3c, 0xff7a1f,
];
const RED = new THREE.Color("#ff4438");
const GREEN = new THREE.Color("#43ff86");

// the night lamps are deliberately generous: a large halo plus a wider, dimmer
// pool on the road, and the halo is three times over the base colour so it
// blooms against the dark basemap
const LAMP_GLOW_SIZE = 26;
const LAMP_POOL_SIZE = 42;
const LAMP_GLOW_INTENSITY = 3;
const LAMP_POOL_INTENSITY = 1.8;

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

/** A lamp (`{lon, lat}`) or a signal (`[lon, lat]`), as the tiles store them. */
export type NightSpot = LampSpot | [number, number];

export interface NightLightTile {
  key: string;
  lamps: NightSpot[];
  signals: NightSpot[];
}

function lonOf(spot: NightSpot): number {
  return Array.isArray(spot) ? spot[0] : spot.lon;
}

function latOf(spot: NightSpot): number {
  return Array.isArray(spot) ? spot[1] : spot.lat;
}

function hashSpot(lon: number, lat: number): number {
  return (
    (Math.imul(Math.round(lon * 1e6), 73856093) ^
      Math.imul(Math.round(lat * 1e6), 19349663)) >>>
    0
  );
}

// the additive glow material shared by every tile of a layer, so the visibility
// pass updates one opacity/size instead of one material per tile
function glowMaterial(size: number, opacity: number): THREE.PointsMaterial {
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
  // Fade the glow with camera distance: a street full of overlapping additive
  // sprites otherwise reads as a bright continuous line when zoomed out. Near
  // lamps stay full, far ones fall to 15% by uFar.
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNear = { value: 200 };
    shader.uniforms.uFar = { value: 1600 };
    shader.vertexShader = shader.vertexShader
      .replace(
        "uniform float scale;",
        "uniform float scale;\nuniform float uNear;\nuniform float uFar;\nvarying float vFade;",
      )
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvFade = mix(1.0, 0.08, smoothstep(uNear, uFar, -mvPosition.z));",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <color_pars_fragment>",
        "#include <color_pars_fragment>\nvarying float vFade;",
      )
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\ndiffuseColor.rgb *= vFade;",
      );
  };
  return material;
}

function diffTiles(
  resident: Iterable<string>,
  wanted: Iterable<string>,
): { added: string[]; removed: string[]; kept: string[] } {
  const residentSet = new Set(resident);
  const wantedSet = new Set(wanted);
  const added: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];
  for (const key of wantedSet) {
    if (residentSet.has(key)) kept.push(key);
    else added.push(key);
  }
  for (const key of residentSet) {
    if (!wantedSet.has(key)) removed.push(key);
  }
  return { added, removed, kept };
}

interface ResidentNightTile {
  lamps: NightSpot[];
  signals: NightSpot[];
  glow: THREE.Points | null;
  pool: THREE.Points | null;
  signalGlow: THREE.Points | null;
  lampPosts: THREE.InstancedMesh | null;
  signalPosts: THREE.InstancedMesh | null;
  // the axis of each signal, aligned with signalGlow's vertices
  axes: number[];
}

/** The warm lamps and the signal heads for the tiles around the centre. */
export class NightLights {
  private readonly scene: THREE.Scene;
  private readonly tiles = new Map<string, ResidentNightTile>();
  private readonly lampGlowMaterial: THREE.PointsMaterial;
  private readonly lampPoolMaterial: THREE.PointsMaterial;
  private readonly signalMaterial: THREE.PointsMaterial;
  private readonly postGeometry: THREE.BufferGeometry;
  private readonly postMaterial: THREE.MeshBasicMaterial;
  private readonly dummy = new THREE.Object3D();
  private readonly capacity: number;
  private originMeters: [number, number] = [0, 0];
  private scaleFactor = 0;
  private originKnown = false;
  private phase = -1;
  private lampsEnabled = true;
  private night = 0;
  private zoom = 20;

  constructor(scene: THREE.Scene, capacity = 80_000) {
    this.scene = scene;
    this.capacity = Math.max(1, capacity);
    this.lampGlowMaterial = glowMaterial(LAMP_GLOW_SIZE, 1);
    this.lampPoolMaterial = glowMaterial(LAMP_POOL_SIZE, 0.32);
    this.signalMaterial = glowMaterial(9, 1);
    // pole + a small head, so the glows sit on something instead of floating
    const pole = new THREE.BoxGeometry(0.16, 0.16, 4.2);
    pole.translate(0, 0, 2.1);
    const head = new THREE.BoxGeometry(0.5, 0.5, 0.22);
    head.translate(0, 0, 4.2);
    this.postGeometry =
      BufferGeometryUtils.mergeGeometries([pole, head]) ?? pole;
    this.postMaterial = new THREE.MeshBasicMaterial({ color: 0x1d2128 });
  }

  /** The resident tiles and the draw calls they own, for stats. */
  get tileCount(): number {
    return this.tiles.size;
  }

  get meshCount(): number {
    let total = 0;
    for (const tile of this.tiles.values()) {
      for (const mesh of [
        tile.glow,
        tile.pool,
        tile.signalGlow,
        tile.lampPosts,
        tile.signalPosts,
      ]) {
        if (mesh) total += 1;
      }
    }
    return total;
  }

  /**
   * Make the resident tiles match `tiles`. A tile that stays with the same lamp
   * and signal arrays is left untouched; an origin reset rebuilds everything
   * because the model coordinates are relative to the origin.
   */
  setTiles(
    tiles: NightLightTile[],
    originMeters: [number, number],
    scaleFactor: number,
  ): void {
    const originChanged =
      !this.originKnown ||
      originMeters[0] !== this.originMeters[0] ||
      originMeters[1] !== this.originMeters[1] ||
      scaleFactor !== this.scaleFactor;
    this.originMeters = originMeters;
    this.scaleFactor = scaleFactor;
    this.originKnown = true;
    if (originChanged) this.clear();

    const wanted = new Map<string, NightLightTile>();
    for (const tile of tiles) {
      if (tile.lamps.length > 0 || tile.signals.length > 0) {
        wanted.set(tile.key, tile);
      }
    }
    const diff = diffTiles(this.tiles.keys(), wanted.keys());
    for (const key of diff.removed) this.removeTile(key);
    for (const key of diff.kept) {
      const entry = this.tiles.get(key)!;
      const tile = wanted.get(key)!;
      if (entry.lamps === tile.lamps && entry.signals === tile.signals) {
        continue;
      }
      // a reloaded tile handed us fresh arrays: rebuild just this tile
      this.removeTile(key);
      this.addTile(tile);
    }
    for (const key of diff.added) this.addTile(wanted.get(key)!);

    this.update(performance.now() / 1000);
    this.applyVisibility();
  }

  private addTile(tile: NightLightTile): void {
    const glow = this.makeLampGlow(tile);
    const pool = this.makeLampPool(tile);
    const signalGlow = this.makeSignalGlow(tile);
    const lampPosts = this.makePosts("lamppost", tile.key, tile.lamps);
    const signalPosts = this.makePosts("signal_post", tile.key, tile.signals);
    this.tiles.set(tile.key, {
      lamps: tile.lamps,
      signals: tile.signals,
      glow,
      pool,
      signalGlow,
      lampPosts,
      signalPosts,
      axes: tile.signals.map((spot) => hashSpot(lonOf(spot), latOf(spot)) % 2),
    });
    if (tile.signals.length > 0) this.phase = -1;
  }

  private positionsOf(spots: NightSpot[], z: number): number[] {
    const positions: number[] = [];
    for (const spot of spots) {
      const m = toModelCoords(
        [lonOf(spot), latOf(spot)],
        this.originMeters,
        this.scaleFactor,
      );
      positions.push(m[0], m[1], z);
    }
    return positions;
  }

  private makeLampGlow(tile: NightLightTile): THREE.Points | null {
    if (tile.lamps.length === 0) return null;
    const colors = new Float32Array(tile.lamps.length * 3);
    const color = new THREE.Color();
    for (let i = 0; i < tile.lamps.length; i++) {
      const spot = tile.lamps[i];
      color.setHex(
        LAMP_COLORS[hashSpot(lonOf(spot), latOf(spot)) % LAMP_COLORS.length],
      );
      colors[i * 3] = color.r * LAMP_GLOW_INTENSITY;
      colors[i * 3 + 1] = color.g * LAMP_GLOW_INTENSITY;
      colors[i * 3 + 2] = color.b * LAMP_GLOW_INTENSITY;
    }
    return this.points(
      this.positionsOf(tile.lamps, 4.35),
      colors,
      this.lampGlowMaterial,
      "lamplight",
      tile.key,
    );
  }

  private makeLampPool(tile: NightLightTile): THREE.Points | null {
    if (tile.lamps.length === 0) return null;
    const colors = new Float32Array(tile.lamps.length * 3);
    const color = new THREE.Color();
    for (let i = 0; i < tile.lamps.length; i++) {
      const spot = tile.lamps[i];
      color.setHex(
        LAMP_COLORS[hashSpot(lonOf(spot), latOf(spot)) % LAMP_COLORS.length],
      );
      colors[i * 3] = color.r * LAMP_POOL_INTENSITY;
      colors[i * 3 + 1] = color.g * LAMP_POOL_INTENSITY;
      colors[i * 3 + 2] = color.b * LAMP_POOL_INTENSITY;
    }
    return this.points(
      this.positionsOf(tile.lamps, 0.25),
      colors,
      this.lampPoolMaterial,
      "lamp_pool",
      tile.key,
    );
  }

  private makeSignalGlow(tile: NightLightTile): THREE.Points | null {
    if (tile.signals.length === 0) return null;
    return this.points(
      this.positionsOf(tile.signals, 4.35),
      new Float32Array(tile.signals.length * 3),
      this.signalMaterial,
      "signal_light",
      tile.key,
    );
  }

  private points(
    positions: number[],
    colors: Float32Array,
    material: THREE.PointsMaterial,
    kind: string,
    tileKey: string,
  ): THREE.Points {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const result = new THREE.Points(geometry, material);
    // the set changes as tiles/centre change, so stale bounds would cull it
    result.frustumCulled = false;
    result.userData = { kind, tile: tileKey };
    this.scene.add(result);
    return result;
  }

  private makePosts(
    kind: "lamppost" | "signal_post",
    tileKey: string,
    spots: NightSpot[],
  ): THREE.InstancedMesh | null {
    if (spots.length === 0) return null;
    const capacity = Math.min(this.capacity, spots.length);
    const posts = new THREE.InstancedMesh(
      this.postGeometry,
      this.postMaterial,
      capacity,
    );
    for (let i = 0; i < capacity; i++) {
      const m = toModelCoords(
        [lonOf(spots[i]), latOf(spots[i])],
        this.originMeters,
        this.scaleFactor,
      );
      this.dummy.position.set(m[0], m[1], 0);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      posts.setMatrixAt(i, this.dummy.matrix);
    }
    posts.count = capacity;
    posts.frustumCulled = false;
    posts.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    posts.instanceMatrix.needsUpdate = true;
    posts.userData = { kind, tile: tileKey };
    this.scene.add(posts);
    return posts;
  }

  private removeTile(key: string): void {
    const tile = this.tiles.get(key);
    if (!tile) return;
    for (const points of [tile.glow, tile.pool, tile.signalGlow]) {
      if (!points) continue;
      points.geometry.dispose();
      points.removeFromParent();
    }
    for (const posts of [tile.lampPosts, tile.signalPosts]) {
      if (!posts) continue;
      // the post geometry and material are shared, so dispose only this
      // mesh's instance buffers
      posts.removeFromParent();
      posts.dispose();
    }
    this.tiles.delete(key);
  }

  clear(): void {
    for (const key of [...this.tiles.keys()]) this.removeTile(key);
    this.phase = -1;
  }

  setVisible(night: number, zoom: number): void {
    this.night = night;
    this.zoom = zoom;
    this.applyVisibility();
  }

  // the lampposts checkbox; the signal heads stay independent
  setLampsEnabled(enabled: boolean): void {
    this.lampsEnabled = enabled;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    const detailed = this.zoom >= NIGHT_LIGHT_MIN_ZOOM;
    const dark = this.night > 0.2;
    // zoomed out, the sprites overlap into a bright continuous line: shrink
    // and dim them with the zoom, then the per-distance fade handles the far
    // side of a close view
    const zoomFactor = Math.max(0, Math.min(1, (this.zoom - 15) / 2.5));
    this.lampGlowMaterial.opacity = 0.2 + 0.8 * zoomFactor;
    this.lampGlowMaterial.size = LAMP_GLOW_SIZE * (0.45 + 0.55 * zoomFactor);
    this.lampPoolMaterial.opacity = 0.32 * (0.2 + 0.8 * zoomFactor);
    this.lampPoolMaterial.size = LAMP_POOL_SIZE * (0.5 + 0.5 * zoomFactor);

    for (const tile of this.tiles.values()) {
      if (tile.glow) {
        tile.glow.visible = detailed && dark && this.lampsEnabled;
      }
      if (tile.pool) {
        tile.pool.visible = detailed && dark && this.lampsEnabled;
      }
      if (tile.lampPosts) {
        tile.lampPosts.visible = detailed && this.lampsEnabled;
      }
      if (tile.signalGlow) tile.signalGlow.visible = detailed && dark;
      if (tile.signalPosts) tile.signalPosts.visible = detailed;
    }
  }

  // the signal heads follow the same global light as the traffic speed bumps
  update(now: number): void {
    const phase = Math.floor(now / SIGNAL_GREEN_S);
    if (phase === this.phase) return;
    this.phase = phase;
    for (const tile of this.tiles.values()) {
      if (!tile.signalGlow || tile.axes.length === 0) continue;
      const colors = tile.signalGlow.geometry.getAttribute("color");
      for (let i = 0; i < tile.axes.length; i++) {
        const color = lightGreen(tile.axes[i], now) ? GREEN : RED;
        colors.setXYZ(i, color.r, color.g, color.b);
      }
      colors.needsUpdate = true;
    }
  }
}
