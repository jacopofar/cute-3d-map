// Car mode: the free-driving car behind the Drive button. The physics is pure
// (`driving.ts`), the mesh is `driving_car.ts` and the geometry tests are
// `collision.ts`; this is the mode around them — the keys and the touch pad,
// the chase camera, the map handlers lent out while driving, and the obstacle
// predicate fed by the loaded tiles.
//
// It lives outside `CoolMap` because it is a mode with its own state machine
// and its own DOM, and because it is the one place that fights the map's own
// gesture handling: keeping that in one object makes the handover auditable.

import type { Map as MapLibreMap } from "maplibre-gl";
import type * as THREE from "three";

import {
  boxesOverlap,
  carRectangle,
  lineIntersectsRect,
  ringIntersectsRect,
} from "./collision";
import {
  headingFromBearing,
  headingToBearing,
  pointAhead,
  type DriveInput,
  type DriveState,
} from "./driving";
import { DrivingCar } from "./driving_car";
import { CAR_TRAFFIC } from "./traffic";
import { getTileIndex } from "./projection";
import type { TileRecord } from "./tile_record";

// The chase camera: high enough to see over the car, tilted so the street reads
// as a street, and looking DRIVE_LOOK_AHEAD meters up the road.
const DRIVE_ZOOM = 20;
const DRIVE_PITCH = 55;
const DRIVE_LOOK_AHEAD = 10;

// The per-frame camera jump keeps the map's 150 ms move debounce from ever
// firing, so the mode runs its own slower tile pass.
const DRIVE_TILE_PASS_MS = 350;
const DRIVE_SHADOW_MS = 1600;
const DRIVE_HUD_MS = 100;

// The car is a rectangle with a little slack, so it does not shave walls.
const DRIVE_CAR_MARGIN = 0.15;
// A building part based above this clears the car; the car drives under it.
const DRIVE_CLEARANCE = 1.6;

const DRIVE_KEY_SET = new Set([
  "w",
  "a",
  "s",
  "d",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
]);

// What the mode needs from the map. It is deliberately small: the map owns the
// view, the tiles and the layers, and the mode asks it to catch up after it has
// moved the camera.
export interface DriveHost {
  readonly map: MapLibreMap;
  readonly tiles: Map<string, TileRecord>;
  /** a fence or wall the user has switched off must not block the car */
  barrierBlocks(kind: string): boolean;
  /** the tile window follows the car, between frames */
  catchUpTiles(): void;
  /** one shadow update, throttled by the mode */
  refreshSunShadow(): void;
  /** leaving the mode hands the map back and rebuilds the window */
  onExit(): void;
  reportPerf(event: Record<string, unknown>): void;
  /** entering the mode drops any open popup */
  clearSelection(): void;
  /** entering the mode stops following a vehicle */
  stopFollowing(): void;
}

export class DriveMode {
  /** whether the mode is on; the map checks this before handling clicks */
  active = false;

  private readonly car: DrivingCar;
  private readonly keys = new Set<string>();
  private readonly host: DriveHost;

  // the map handlers disabled on entry, so exiting restores exactly these
  private interactions?: {
    dragPan: boolean;
    dragRotate: boolean;
    scrollZoom: boolean;
    boxZoom: boolean;
    doubleClickZoom: boolean;
    touchZoomRotate: boolean;
    touchPitch: boolean;
    keyboard: boolean;
  };

  // the HUD nodes, looked up once when the mode is wired
  private button?: HTMLButtonElement;
  private hud?: HTMLElement;
  private speed?: HTMLElement;
  private pad?: HTMLElement;

  private lastFrame = 0;
  private lastTilePass = 0;
  private lastShadow = 0;
  private lastHud = 0;
  private tileTimer: ReturnType<typeof setTimeout> | undefined;

  // the on-screen steering/pedal buttons, merged into the keyboard input
  private touchInput: DriveInput = {
    forward: false,
    backward: false,
    left: false,
    right: false,
  };

  constructor(host: DriveHost, scene: THREE.Scene) {
    this.host = host;
    this.car = new DrivingCar(scene);
  }

  // wire the button, the keys and the touch pad. Called once by the map.
  wire(): void {
    this.button =
      document.querySelector<HTMLButtonElement>("#drive-button") ?? undefined;
    this.hud = document.querySelector<HTMLElement>("#drive-hud") ?? undefined;
    this.speed =
      document.querySelector<HTMLElement>("#drive-speed") ?? undefined;
    this.pad = document.querySelector<HTMLElement>("#drive-touch") ?? undefined;
    this.button?.addEventListener("click", () => {
      if (this.active) this.stop();
      else this.start();
    });
    this.wireTouch();
    window.addEventListener("keydown", (event) => this.onKeyDown(event));
    window.addEventListener("keyup", (event) => this.onKeyUp(event));
    // a key or a thumb held when the window loses focus would stay down forever
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.clearTouch();
    });
    this.applyUi();
  }

  start(): void {
    if (this.active) return;
    this.host.stopFollowing();
    this.host.clearSelection();
    this.active = true;
    this.keys.clear();
    this.clearTouch();
    const spawn = this.spawn();
    this.car.start(spawn.lon, spawn.lat, spawn.heading);
    // the map's own gestures would fight a camera that jumps every frame
    const map = this.host.map;
    this.interactions = {
      dragPan: map.dragPan.isEnabled(),
      dragRotate: map.dragRotate.isEnabled(),
      scrollZoom: map.scrollZoom.isEnabled(),
      boxZoom: map.boxZoom.isEnabled(),
      doubleClickZoom: map.doubleClickZoom.isEnabled(),
      touchZoomRotate: map.touchZoomRotate.isEnabled(),
      touchPitch: map.touchPitch.isEnabled(),
      keyboard: map.keyboard.isEnabled(),
    };
    map.dragPan.disable();
    map.dragRotate.disable();
    map.scrollZoom.disable();
    map.boxZoom.disable();
    map.doubleClickZoom.disable();
    map.touchZoomRotate.disable();
    map.touchPitch.disable();
    map.keyboard.disable();
    const now = performance.now();
    this.lastFrame = now;
    this.lastTilePass = now;
    this.lastShadow = now;
    this.lastHud = 0;
    map.jumpTo({ zoom: DRIVE_ZOOM, pitch: DRIVE_PITCH });
    this.applyUi();
    this.host.reportPerf({ event: "drive-start" });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.keys.clear();
    this.clearTouch();
    this.lastFrame = 0;
    this.car.stop();
    const map = this.host.map;
    const previous = this.interactions;
    if (previous) {
      // put back exactly what was enabled before, not "everything on"
      const restore = (was: boolean, on: () => void, off: () => void) =>
        was ? on() : off();
      restore(
        previous.dragPan,
        () => map.dragPan.enable(),
        () => map.dragPan.disable(),
      );
      restore(
        previous.dragRotate,
        () => map.dragRotate.enable(),
        () => map.dragRotate.disable(),
      );
      restore(
        previous.scrollZoom,
        () => map.scrollZoom.enable(),
        () => map.scrollZoom.disable(),
      );
      restore(
        previous.boxZoom,
        () => map.boxZoom.enable(),
        () => map.boxZoom.disable(),
      );
      restore(
        previous.doubleClickZoom,
        () => map.doubleClickZoom.enable(),
        () => map.doubleClickZoom.disable(),
      );
      restore(
        previous.touchZoomRotate,
        () => map.touchZoomRotate.enable(),
        () => map.touchZoomRotate.disable(),
      );
      restore(
        previous.touchPitch,
        () => map.touchPitch.enable(),
        () => map.touchPitch.disable(),
      );
      restore(
        previous.keyboard,
        () => map.keyboard.enable(),
        () => map.keyboard.disable(),
      );
      this.interactions = undefined;
    }
    this.applyUi();
    this.host.reportPerf({ event: "drive-stop" });
    this.host.onExit();
  }

  // Advance the car and put the chase camera where it is heading. Runs from the
  // render callback, so it shares the frame clock with everything else.
  update(originMeters: [number, number], scaleFactor: number): void {
    if (!this.active) return;
    const now = performance.now();
    const dt = this.lastFrame > 0 ? (now - this.lastFrame) / 1000 : 0;
    this.lastFrame = now;
    const state = this.car.update(
      this.input(),
      dt,
      originMeters,
      scaleFactor,
      (candidate) => this.blocked(candidate),
    );
    const ahead = pointAhead(
      state.lon,
      state.lat,
      state.heading,
      DRIVE_LOOK_AHEAD,
    );
    this.host.map.jumpTo({
      center: ahead,
      bearing: headingToBearing(state.heading),
      pitch: DRIVE_PITCH,
      zoom: DRIVE_ZOOM,
    });
    // Run the tile pass after the render task, like the move debounce does, so
    // a projection origin reset lands between frames instead of mid-render.
    if (
      now - this.lastTilePass >= DRIVE_TILE_PASS_MS &&
      this.tileTimer === undefined
    ) {
      this.lastTilePass = now;
      this.tileTimer = setTimeout(() => {
        this.tileTimer = undefined;
        if (!this.active) return;
        this.host.catchUpTiles();
        const at = performance.now();
        if (at - this.lastShadow >= DRIVE_SHADOW_MS) {
          this.lastShadow = at;
          this.host.refreshSunShadow();
        }
      }, 0);
    }
    if (now - this.lastHud >= DRIVE_HUD_MS) {
      this.lastHud = now;
      if (this.speed) {
        const kmh = Math.round(Math.abs(state.speed) * 3.6);
        this.speed.textContent =
          state.speed < -0.1 ? `R ${kmh} km/h` : `${kmh} km/h`;
      }
    }
  }

  // Whether the car's rectangle would overlap a building or a fence/wall at
  // `state`. The car only ever touches the tile it is in and the ring around
  // it, so those nine tiles are enough; each obstacle also has a precomputed
  // bbox, which rejects almost all of them before the edge tests.
  blocked(state: DriveState): boolean {
    const [cx, cy] = getTileIndex({ lng: state.lon, lat: state.lat });
    const rect = carRectangle(
      state.lon,
      state.lat,
      state.heading,
      CAR_TRAFFIC.length,
      CAR_TRAFFIC.width,
      DRIVE_CAR_MARGIN,
    );
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        const objects = this.host.tiles.get(`${x}_${y}`)?.objects;
        if (!objects) continue;
        for (const building of objects.buildings) {
          if (!building.bbox || !boxesOverlap(rect.box, building.bbox)) {
            continue;
          }
          // a high building part floats over the street; the car drives under
          if ((building.base ?? 0) > DRIVE_CLEARANCE) continue;
          if (building.rings.some((ring) => ringIntersectsRect(ring, rect))) {
            return true;
          }
        }
        for (const barrier of objects.barriers) {
          // a hidden barrier must not block: the layer checkbox is the truth
          if (!this.host.barrierBlocks(barrier.kind)) continue;
          if (!boxesOverlap(rect.box, barrier.bbox)) continue;
          if (lineIntersectsRect(barrier.coords, rect)) return true;
        }
      }
    }
    return false;
  }

  // read-only state for the e2e (like stats()): where the car is and how fast
  state(): {
    lon: number;
    lat: number;
    heading: number;
    speed: number;
    active: boolean;
  } {
    const state = this.car.current;
    const center = this.host.map.getCenter();
    return {
      active: this.active,
      lon: state?.lon ?? center.lng,
      lat: state?.lat ?? center.lat,
      heading: state?.heading ?? 0,
      speed: state?.speed ?? 0,
    };
  }

  // Start on the nearest precomputed car route when one is loaded. A map center
  // picked by the user can be inside a building, and a car under a roof is
  // invisible; a road point also gives the car a sensible starting heading.
  // Falls back to the map center when no route has loaded yet.
  private spawn(): { lon: number; lat: number; heading: number } {
    const center = this.host.map.getCenter();
    const cosLat = Math.cos((center.lat * Math.PI) / 180);
    let best: { lon: number; lat: number; heading: number } | undefined;
    let bestDeg2 = Infinity;
    for (const { objects } of this.host.tiles.values()) {
      for (const loop of objects.traffic) {
        if (loop.kind !== "car") continue;
        for (const run of loop.runs) {
          const coords = run.coords;
          for (let i = 1; i < coords.length; i++) {
            const [lon, lat] = coords[i];
            const dLon = (lon - center.lng) * cosLat;
            const dLat = lat - center.lat;
            const d2 = dLon * dLon + dLat * dLat;
            if (d2 >= bestDeg2) continue;
            const [prevLon, prevLat] = coords[i - 1];
            // a dwell keyframe repeats a coordinate; it has no heading
            if (prevLon === lon && prevLat === lat) continue;
            bestDeg2 = d2;
            best = {
              lon,
              lat,
              heading: Math.atan2(
                (lat - prevLat) * 110_540,
                (lon - prevLon) * cosLat * 111_320,
              ),
            };
          }
        }
      }
    }
    // within ~300 m: farther than that and the map center is more honest than
    // some road across the city
    if (best && bestDeg2 <= (300 / 111_320) ** 2) return best;
    return {
      lon: center.lng,
      lat: center.lat,
      heading: headingFromBearing(this.host.map.getBearing()),
    };
  }

  private applyUi(): void {
    if (this.button) {
      this.button.setAttribute("aria-pressed", String(this.active));
      const label = this.button.querySelector("#drive-button-label");
      if (label) label.textContent = this.active ? "Exit drive" : "Drive";
    }
    if (this.hud) this.hud.hidden = !this.active;
    // the CSS only shows the touch pad on a coarse pointer
    if (this.pad) this.pad.hidden = !this.active;
  }

  // Wire the on-screen buttons to the same input flags as the keyboard. Pointer
  // capture keeps a thumb that slides off the button held until it lifts, and
  // the try catches a synthetic pointer from a test (which cannot be captured).
  private wireTouch(): void {
    const buttons = this.pad?.querySelectorAll<HTMLButtonElement>(
      "[data-drive-action]",
    );
    if (!buttons) return;
    const actions = new Set<keyof DriveInput>([
      "forward",
      "backward",
      "left",
      "right",
    ]);
    buttons.forEach((button) => {
      const action = button.dataset.driveAction as keyof DriveInput | undefined;
      if (!action || !actions.has(action)) return;
      const set = (on: boolean) => {
        this.touchInput[action] = on;
        button.classList.toggle("pressed", on);
        button.setAttribute("aria-pressed", String(on));
      };
      button.addEventListener("pointerdown", (event) => {
        // no scroll, text selection or callout from a held thumb
        event.preventDefault();
        try {
          button.setPointerCapture(event.pointerId);
        } catch {
          // a synthetic pointer has no active capture
        }
        set(true);
      });
      const release = () => set(false);
      button.addEventListener("pointerup", release);
      button.addEventListener("pointercancel", release);
      button.addEventListener("lostpointercapture", release);
      button.addEventListener("contextmenu", (event) => event.preventDefault());
    });
  }

  private clearTouch(): void {
    this.touchInput = {
      forward: false,
      backward: false,
      left: false,
      right: false,
    };
    this.pad
      ?.querySelectorAll<HTMLButtonElement>(".drive-touch-button")
      .forEach((button) => {
        button.classList.remove("pressed");
        button.setAttribute("aria-pressed", "false");
      });
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.active) return;
    const key = event.key.toLowerCase();
    if (key === "escape") {
      event.preventDefault();
      this.stop();
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        /^(input|textarea|select)$/i.test(target.tagName))
    ) {
      return;
    }
    if (!DRIVE_KEY_SET.has(key)) return;
    // keep the arrows from scrolling the page and the map from panning
    event.preventDefault();
    this.keys.add(key);
  }

  private onKeyUp(event: KeyboardEvent): void {
    this.keys.delete(event.key.toLowerCase());
  }

  private input(): DriveInput {
    const keys = this.keys;
    const touch = this.touchInput;
    return {
      forward: keys.has("w") || keys.has("arrowup") || touch.forward,
      backward: keys.has("s") || keys.has("arrowdown") || touch.backward,
      left: keys.has("a") || keys.has("arrowleft") || touch.left,
      right: keys.has("d") || keys.has("arrowright") || touch.right,
    };
  }
}
