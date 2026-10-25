// The day/night rig: the three lights, the ground and the shadow catcher, and
// everything that follows the sun — the renderer exposure, the lit-window and
// glass shaders, the water glitter, the fog, the MapLibre sky, the grade
// overlay, the basemap style swap and the shadow-camera debounce.
//
// The solar model itself is `daynight.ts` (pure, unit-tested); this is the part
// that pushes it onto a scene. It lives outside `CoolMap` because the rig is
// built once and then only ever re-applied, and because the materials it pokes
// are module singletons that need no map to reach.

import type { Map as MapLibreMap } from "maplibre-gl";
import * as THREE from "three";

import { crosswalkMaterial } from "./elements3d/crosswalk";
import { windowMaterial } from "./elements3d/facade";
import { fountainWaterMaterial } from "./elements3d/fountain";
import { glassMaterial } from "./elements3d/glass";
import { greenMaterial } from "./elements3d/green";
import { roadMarkingMaterial } from "./elements3d/road_marking";
import { waterMaterial } from "./elements3d/water";
import {
  DAY_HOUR,
  NIGHT_HOUR,
  currentMilanSolarHour,
  lerpColor,
  lightingAt,
  type Lighting,
} from "./daynight";
import { epsg4326toEpsg3857, scaleFactorAt, toModelCoords } from "./projection";

// MapTiler basemap styles. The map opens on the day style and swaps to the dark
// one at night, so the bright basemap does not clash with the dark 3D scene.
export const BASEMAP_DAY = "basic-v2";
export const BASEMAP_NIGHT = "basic-v2-dark";
// a style with no sources or layers: the "basemap off" state
const EMPTY_BASEMAP_STYLE = { version: 8 as const, sources: {}, layers: [] };
// the night factor above which the dark basemap and the night toggle count as
// "night" (~sun 6 degrees below the horizon)
export const BASEMAP_NIGHT_AT = 0.5;
// the night factor above which bloom is worth its two extra passes
export const BLOOM_NIGHT_AT = 0.35;

// how long a burst of tile loads waits before the shadow map is redrawn
const SHADOW_DEBOUNCE_MS = 200;

export const basemapStyleUrl = (name: string): string =>
  `https://api.maptiler.com/maps/${name}/style.json?key=${import.meta.env.VITE_MAPTILER_KEY}`;

// A saved day/night switch wins over the solar seed, so the first basemap is the
// one the user last chose instead of a frame of the other one.
export function initialHour(savedNight: boolean | undefined): number {
  if (savedNight !== undefined) return savedNight ? NIGHT_HOUR : DAY_HOUR;
  return Math.round(currentMilanSolarHour() * 4) / 4;
}

export function isNightHour(hour: number): boolean {
  return lightingAt(hour).night > BASEMAP_NIGHT_AT;
}

export interface LightingHost {
  readonly map: MapLibreMap;
  readonly scene: THREE.Scene;
  /** the projection origin, in lon/lat */
  center(): [number, number];
  /** the cloud layer and the street lamps follow the same night factor */
  onNight(night: number): void;
}

export class LightingRig {
  private readonly sun: THREE.DirectionalLight;
  private readonly fill: THREE.DirectionalLight;
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly ground: THREE.Mesh;
  private readonly shadowGround: THREE.Mesh;

  private hour: number;
  private state: Lighting;
  private darkBasemap: boolean;
  private basemapEnabled = true;
  private softwareRenderer = false;
  private renderer?: THREE.WebGLRenderer;
  private shadowTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly host: LightingHost;

  constructor(host: LightingHost, hour: number) {
    this.host = host;
    this.hour = hour;
    this.state = lightingAt(hour);
    this.darkBasemap = isNightHour(hour);

    const scene = host.scene;
    // atmospheric fog, matched to the sky color in apply(); it blends the far
    // 3D edges into the horizon instead of cutting off
    scene.fog = new THREE.Fog(0xd9e3ea, 1200, 6000);

    // a warm sun, a cool fill from the opposite side, and a hemisphere light so
    // faces away from the sun are not pitch black. Their colors and intensities
    // are set from the time of day in apply(), so the starting values do not
    // matter much.
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    this.sun.position.set(-40, 60, 100).normalize();
    // one tight shadow cascade around the view: 2 km across is enough at city
    // zooms and keeps the texel size usable at 2048
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -1000;
    this.sun.shadow.camera.right = 1000;
    this.sun.shadow.camera.top = 1000;
    this.sun.shadow.camera.bottom = -1000;
    // the light sits 3 km out; a tight depth range keeps the 24-bit depth
    // precise enough to avoid acne on roofs and walls
    this.sun.shadow.camera.near = 1000;
    this.sun.shadow.camera.far = 5000;
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 2.0;
    scene.add(this.sun.target);
    scene.add(this.sun);

    this.fill = new THREE.DirectionalLight(0xbfd4ff, 0.6);
    this.fill.position.set(60, -50, 60).normalize();
    scene.add(this.fill);

    this.hemisphere = new THREE.HemisphereLight(0xcfe0ff, 0x4a4030, 1.0);
    scene.add(this.hemisphere);

    // faint ground plane under everything (also a shadow catcher later)
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(20000, 20000),
      new THREE.MeshBasicMaterial({
        color: 0x8a8f95,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
      }),
    );
    this.ground.position.z = -0.05;
    this.ground.renderOrder = -1;
    scene.add(this.ground);

    // a transparent catcher for the sun shadows: it darkens the basemap and the
    // ground under buildings, trees and cars without covering it
    const shadowMaterial = new THREE.ShadowMaterial({ opacity: 0.32 });
    shadowMaterial.depthWrite = false;
    this.shadowGround = new THREE.Mesh(
      new THREE.PlaneGeometry(20000, 20000),
      shadowMaterial,
    );
    this.shadowGround.position.z = -0.04;
    this.shadowGround.receiveShadow = true;
    this.shadowGround.renderOrder = -0.5;
    this.shadowGround.frustumCulled = false;
    scene.add(this.shadowGround);
  }

  get night(): number {
    return this.state.night;
  }

  get timeOfDay(): number {
    return this.hour;
  }

  // the renderer arrives with the custom layer, after the rig is built
  setRenderer(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;
  }

  // headless CI renders on SwiftShader, where the shadow pass roughly doubles
  // the frame time, so it is off there
  setSoftwareRenderer(software: boolean): void {
    this.softwareRenderer = software;
    this.sun.castShadow = !software;
    this.shadowGround.visible = !software;
  }

  setTimeOfDay(hour: number): void {
    this.hour = hour;
    this.apply();
  }

  // Push the time-of-day model onto the scene. Called when the time changes and
  // once from the layer's onAdd, not every frame.
  apply(): void {
    const lighting = (this.state = lightingAt(this.hour));
    this.sun.color.setHex(lighting.keyColor);
    this.sun.intensity = lighting.keyIntensity;
    this.sun.position.set(...lighting.keyDirection).normalize();
    this.fill.color.setHex(lighting.fillColor);
    this.fill.intensity = lighting.fillIntensity;
    this.hemisphere.color.setHex(lighting.skyColor);
    this.hemisphere.groundColor.setHex(lighting.groundColor);
    this.hemisphere.intensity = lighting.hemisphereIntensity;
    (this.ground.material as THREE.MeshBasicMaterial).color.setHex(
      lerpColor(0x11151c, 0x8a8f95, 1 - lighting.night),
    );
    // Painted road markings are lit, but a pure white Lambert still reads
    // brighter than the night street and feeds the bloom. Dim the whole paint
    // material with the same night factor; daylight stays pure white.
    const paint = 1 - 0.72 * lighting.night;
    crosswalkMaterial.color.setScalar(paint);
    roadMarkingMaterial.color.setScalar(paint);
    if (this.renderer) {
      this.renderer.toneMappingExposure = lighting.exposure;
    }
    // the window shader reads the same key light, so the glass tracks dawn/dusk
    windowMaterial.uniforms.uNight.value = lighting.night;
    windowMaterial.uniforms.uKeyDirection.value
      .set(...lighting.keyDirection)
      .normalize();
    windowMaterial.uniforms.uKeyColor.value.setHex(lighting.keyColor);
    windowMaterial.uniforms.uKeyIntensity.value = lighting.keyIntensity;
    windowMaterial.uniforms.uAmbientColor.value.setHex(lighting.skyColor);
    windowMaterial.uniforms.uAmbientIntensity.value =
      lighting.hemisphereIntensity;
    // glass walls read the same sun and sky as the windows, so a curtain wall
    // reflects the same dawn and goes just as dark at night
    glassMaterial.uniforms.uNight.value = lighting.night;
    glassMaterial.uniforms.uKeyDirection.value
      .set(...lighting.keyDirection)
      .normalize();
    glassMaterial.uniforms.uKeyColor.value.setHex(lighting.keyColor);
    glassMaterial.uniforms.uKeyIntensity.value = lighting.keyIntensity;
    glassMaterial.uniforms.uAmbientColor.value.setHex(lighting.skyColor);
    glassMaterial.uniforms.uAmbientIntensity.value =
      lighting.hemisphereIntensity;
    waterMaterial.uniforms.uNight.value = lighting.night;
    fountainWaterMaterial.uniforms.uNight.value = lighting.night;
    // the glitter on the water is the same key light the windows get: its color
    // warms at the horizon and its direction is the real sun, so the reflection
    // sits under the sun instead of wherever the bands happen to be
    waterMaterial.uniforms.uSunDirection.value
      .set(...lighting.keyDirection)
      .normalize();
    waterMaterial.uniforms.uSunColor.value.setHex(lighting.keyColor);
    waterMaterial.uniforms.uSunIntensity.value = lighting.keyIntensity;
    greenMaterial.uniforms.uNight.value = lighting.night;
    // the fog and the MapLibre sky follow the same palette as the lights, so
    // distant geometry dissolves into the horizon instead of stopping abruptly
    if (this.host.scene.fog instanceof THREE.Fog) {
      this.host.scene.fog.color.setHex(lighting.skyFog);
    }
    this.shadowGround.visible = !this.softwareRenderer;
    (this.shadowGround.material as THREE.ShadowMaterial).opacity = Math.min(
      0.4,
      0.15 * lighting.keyIntensity,
    );
    this.applySky(lighting);
    this.host.onNight(lighting.night);
    this.refreshSunShadow();
    const grade = document.querySelector<HTMLElement>("#grade");
    if (grade) {
      grade.style.backgroundColor = `#${lighting.gradeColor
        .toString(16)
        .padStart(6, "0")}`;
      grade.style.opacity = String(lighting.gradeOpacity);
    }
    this.applyBasemap(lighting.night > BASEMAP_NIGHT_AT);
  }

  // MapLibre's sky/atmosphere: a gradient from the zenith to the horizon with
  // fog, warmed through sunrise/sunset and deep blue at night.
  private applySky(lighting: Lighting): void {
    if (!this.host.map.isStyleLoaded()) return;
    const hex = (color: number) => `#${color.toString(16).padStart(6, "0")}`;
    this.host.map.setSky({
      "sky-color": hex(lighting.skyTop),
      "horizon-color": hex(lighting.skyHorizon),
      "fog-color": hex(lighting.skyFog),
      "sky-horizon-blend": 0.6,
      "horizon-fog-blend": 0.45,
      "fog-ground-blend": 0.6,
      "atmosphere-blend": 1,
    });
  }

  // Reposition the sun and its shadow camera and request one shadow-map render.
  // Debounced: a burst of tile loads (each one would otherwise trigger a full
  // 2.4M-caster shadow pass) coalesces into one, and the view settling updates
  // it once.
  refreshSunShadow(): void {
    if (this.softwareRenderer) return;
    if (this.shadowTimer !== undefined) clearTimeout(this.shadowTimer);
    this.shadowTimer = setTimeout(() => {
      this.shadowTimer = undefined;
      this.applySunShadow();
    }, SHADOW_DEBOUNCE_MS);
  }

  private applySunShadow(): void {
    if (this.softwareRenderer) return;
    const originMeters = epsg4326toEpsg3857(this.host.center());
    const scaleFactor = scaleFactorAt(this.host.center()[1]);
    const center = this.host.map.getCenter();
    const [x, y] = toModelCoords(
      [center.lng, center.lat],
      originMeters,
      scaleFactor,
    );
    const direction = this.state.keyDirection;
    this.sun.target.position.set(x, y, 0);
    this.sun.target.updateMatrixWorld();
    this.sun.position.set(
      x + direction[0] * 3000,
      y + direction[1] * 3000,
      direction[2] * 3000,
    );
    this.sun.updateMatrixWorld();
    if (this.renderer) this.renderer.shadowMap.needsUpdate = true;
  }

  // Swap the basemap to the dark MapTiler style at night (and back by day).
  // setStyle diffs, so the custom layer usually survives it; the style.load
  // handler and onAdd are both written to tolerate a re-add just in case.
  // Remembering the mounted style keeps the swap to once per crossing, not on
  // every lighting update.
  setBasemapEnabled(on: boolean): void {
    if (on === this.basemapEnabled) return;
    this.basemapEnabled = on;
    const fade = document.querySelector<HTMLElement>("#basemap-fade");
    if (fade) fade.style.opacity = "0";
    if (on) {
      const night = this.state.night > BASEMAP_NIGHT_AT;
      this.darkBasemap = night;
      this.host.map.setStyle(
        basemapStyleUrl(night ? BASEMAP_NIGHT : BASEMAP_DAY),
      );
    } else {
      this.host.map.setStyle(EMPTY_BASEMAP_STYLE);
    }
  }

  private applyBasemap(night: boolean): void {
    if (!this.basemapEnabled) return;
    if (night === this.darkBasemap) return;
    this.darkBasemap = night;
    const fade = document.querySelector<HTMLElement>("#basemap-fade");
    if (!fade) {
      this.host.map.setStyle(
        basemapStyleUrl(night ? BASEMAP_NIGHT : BASEMAP_DAY),
      );
      return;
    }
    // fade through black, swap under the cover, then reveal the new style
    fade.style.opacity = "1";
    let done = false;
    const reveal = () => {
      if (done) return;
      done = true;
      fade.style.opacity = "0";
    };
    setTimeout(() => {
      this.host.map.once("style.load", reveal);
      this.host.map.setStyle(
        basemapStyleUrl(night ? BASEMAP_NIGHT : BASEMAP_DAY),
      );
      // the style load is normally quick; do not stay black if it never fires
      setTimeout(reveal, 900);
    }, 230);
  }

  // read-only day/night state for the e2e (like stats()): the current hour, the
  // 0..1 night factor and the key-light intensity
  readState(): { hour: number; night: number; sunIntensity: number } {
    return {
      hour: this.hour,
      night: this.state.night,
      sunIntensity: this.state.keyIntensity,
    };
  }
}
