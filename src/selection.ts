// Click selection: which object a click hit, the ground ring that marks it and
// the popup that describes it. Every layer has its own small picker (`waterAt`,
// `rooftopAt`, ...) and the point-feature ones are wired through one table, so a
// new layer is a row rather than a branch in the click handler.
//
// This used to be half of `main.ts`: the cluster only needs the tile store, the
// map (for popups and the building zoom), the scene (for the ring) and the
// projection origin, so those come in through `SelectionHost`.

import { Popup } from "maplibre-gl";
import type { LngLat, LngLatLike, Map as MapLibreMap } from "maplibre-gl";
import type Geojson from "geojson";
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

import {
  barrierAt,
  featureAt,
  ringContains,
  ringDistance,
} from "./feature_pick";
import { building } from "./elements3d/building";
import { waterwayWidth } from "./elements3d/water";
import { pitchSportOf } from "./elements3d/pitch_layout";
import type {
  BarrierInfo,
  BuildingInfo,
  ConstructionInfo,
  CrosswalkInfo,
  FeatureInfo,
  FountainInfo,
  FurnitureInfo,
  MonumentInfo,
  PlatformInfo,
  PlaygroundInfo,
  RooftopInfo,
  TerraceInfo,
  TransitInfo,
  WaterInfo,
} from "./geojson_data";
import { epsg4326toEpsg3857, scaleFactorAt, toModelCoords } from "./projection";
import type { TileRecord } from "./tile_record";
import { escapeHtml, osmLink } from "./ui/html";

// what the furniture popup calls each mapped kind
const FURNITURE_LABELS: Record<string, string> = {
  bollard: "Bollard",
  bin: "Waste basket",
  bike_rack: "Bicycle parking",
  post_box: "Post box",
  drinking_water: "Drinking fountain",
  info_board: "Information board",
  hydrant: "Fire hydrant",
};

// The mesh kinds that share the generic FeatureInfo picker, mapped to the
// feature kinds to search. A tree row is drawn as trees, so a tree hit has to
// consider both; a power wire is the mesh of a power_line feature.
const FEATURE_PICK_KINDS: Record<string, string[]> = {
  tree: ["tree", "tree_row"],
  bench: ["bench"],
  green: ["green"],
  cemetery: ["cemetery"],
  rail: ["rail"],
  park_path: ["park_path"],
  power_tower: ["power_tower"],
  power_wire: ["power_line"],
  bridge: ["bridge"],
  tunnel: ["tunnel"],
  gate: ["gate"],
  aeroway: ["aeroway"],
  road_marking: ["road_marking"],
};

// how far a hit may land from the feature and still count, in meters. A runway
// is buffered to its half width, so its hit is far from the centreline; a flat
// area is usually a containment hit and needs no slack.
const FEATURE_PICK_RADIUS: Record<string, number> = {
  tree: 5,
  tree_row: 5,
  bench: 3,
  green: 5,
  cemetery: 5,
  rail: 6,
  park_path: 5,
  power_tower: 8,
  power_line: 8,
  bridge: 12,
  tunnel: 8,
  gate: 4,
  aeroway: 40,
  road_marking: 12,
  fence: 4,
  wall: 4,
};

// A fountain is picked from its basin, not its centre point: tilegen clamps the
// size to 12 m, so this also covers the rim and a slightly-off click.
const FOUNTAIN_PICK_RADIUS = 8;

// Mesh kinds a click can hit, and whether the layer's checkbox gates them: a
// hidden layer must not be pickable either. The kinds with no toggle of their
// own (buildings, trees, painted markings, ...) are always pickable; a kind
// missing from this table has no popup at all.
// the popup's name for the sports a pitch can be; anything else is generic
const PITCH_LABELS: Record<string, string> = {
  soccer: "Soccer pitch",
  futsal: "Futsal pitch",
  "five-a-side": "Five-a-side pitch",
  tennis: "Tennis court",
  padel: "Padel court",
  basketball: "Basketball court",
  multi: "Multi-use court",
  volleyball: "Volleyball court",
  beachvolleyball: "Beach volleyball court",
  athletics: "Athletics track",
  rugby: "Rugby pitch",
  rugby_union: "Rugby pitch",
  rugby_league: "Rugby league pitch",
  baseball: "Baseball field",
  softball: "Softball field",
};

const PICKABLE_KINDS: Record<string, "always" | "when-visible"> = {
  building: "always",
  glass: "always",
  tree: "always",
  cemetery: "always",
  furniture: "always",
  fountain: "always",
  fountain_water: "always",
  terrace: "always",
  playground: "always",
  monument: "always",
  construction: "always",
  crosswalk: "always",
  road_marking: "always",
  water: "when-visible",
  roof: "when-visible",
  church: "when-visible",
  bench: "when-visible",
  green: "when-visible",
  rail: "when-visible",
  park_path: "when-visible",
  power_tower: "when-visible",
  power_wire: "when-visible",
  bridge: "when-visible",
  tunnel: "when-visible",
  gate: "when-visible",
  fence: "when-visible",
  wall: "when-visible",
  aeroway: "when-visible",
  platform: "when-visible",
  transit_stop: "when-visible",
  metro_sign: "when-visible",
  rooftop: "when-visible",
  custom_model: "when-visible",
};

// The hover ring: small enough to read as "this object", bright enough to see
// over both grass and asphalt without competing with the click highlight.
const HOVER_RADIUS = 1.4;
const HOVER_Z = 0.14;

// One entry per mesh kind that resolves to a point feature: `at` searches the
// tile data around the hit point, `select` opens the popup for what it found.
// The pair is type-checked at the `picker()` call and erased to `unknown`
// afterwards, which is sound because both halves come from the same call.
interface Picker {
  at: (
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ) => unknown;
  select: (info: unknown, lngLat: LngLat) => void;
}

function picker<T>(
  owner: object,
  at: (
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ) => T | undefined,
  select: (info: T, lngLat: LngLat) => void,
): Picker {
  return {
    at: at.bind(owner),
    select: (info, lngLat) => select.call(owner, info as T, lngLat),
  };
}

// What the selection needs from the map. Keeping it this small is what makes
// the click handling readable, and it is a checklist of what would need
// rethinking if the map ever grew a second viewport.
export interface SelectionHost {
  readonly tiles: Map<string, TileRecord>;
  readonly map: MapLibreMap;
  readonly scene: THREE.Scene;
  /** the projection origin, in lon/lat */
  center(): [number, number];
  /** whether the rooftop layer is drawn: a mapped solar panel outranks the
   * building it sits on */
  rooftopsVisible(): boolean;
}

export class Selection {
  private highlight?: THREE.Object3D;
  private popup?: Popup;
  // one ring, reused and moved: a fresh LineLoop per mouse tick would churn
  // geometry 16 times a second for a decoration
  private hoverRing?: THREE.LineLoop;
  private hovered?: string;

  private readonly host: SelectionHost;

  constructor(host: SelectionHost) {
    this.host = host;
  }

  // the loaded meshes a click may hit, filtered by the layer switches
  pickableMeshes(): THREE.Object3D[] {
    const pickable: THREE.Object3D[] = [];
    for (const record of this.host.tiles.values()) {
      for (const mesh of record.objects.meshes) {
        const rule = PICKABLE_KINDS[mesh.userData.kind as string];
        if (rule === "always" || (rule === "when-visible" && mesh.visible)) {
          pickable.push(mesh);
        }
      }
    }
    return pickable;
  }

  // What is under the cursor: a small ring at the hit point and the mesh kind,
  // so the map can show a pointer. Unlike `pickStatic` this opens nothing and
  // leaves any open popup alone.
  hover(hit: THREE.Intersection | undefined): string | null {
    const kind = hit ? ((hit.object.userData.kind as string) ?? null) : null;
    if (!hit || !kind || !(kind in PICKABLE_KINDS)) {
      this.clearHover();
      return null;
    }
    const ring = this.hoverMark();
    ring.position.set(hit.point.x, hit.point.y, HOVER_Z);
    ring.visible = true;
    this.hovered = kind;
    return kind;
  }

  clearHover(): void {
    if (this.hoverRing) this.hoverRing.visible = false;
    this.hovered = undefined;
  }

  // the kind under the cursor, for the e2e probe
  get hoverKind(): string | null {
    return this.hovered ?? null;
  }

  private hoverMark(): THREE.LineLoop {
    if (!this.hoverRing) {
      const ring: THREE.Vector3[] = [];
      for (let i = 0; i < 32; i++) {
        const angle = (i / 32) * Math.PI * 2;
        ring.push(new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0));
      }
      // a unit circle in the ground plane, scaled to HOVER_RADIUS: moving it is
      // the only per-tick work
      this.hoverRing = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(ring),
        new THREE.LineBasicMaterial({
          color: 0x7fe3ff,
          depthTest: false,
          transparent: true,
        }),
      );
      this.hoverRing.scale.setScalar(HOVER_RADIUS);
      this.hoverRing.renderOrder = 998;
      this.hoverRing.visible = false;
      this.host.scene.add(this.hoverRing);
    }
    return this.hoverRing;
  }

  // keep the open popup over a followed vehicle
  reposition(lngLat: [number, number]): void {
    this.popup?.setLngLat(lngLat);
  }

  // remove the ring and the popup
  clear() {
    if (this.highlight) {
      this.host.scene.remove(this.highlight);
      // the outline's geometry and material are created per selection
      if (
        this.highlight instanceof THREE.LineSegments ||
        this.highlight instanceof THREE.LineLoop
      ) {
        this.highlight.geometry.dispose();
        this.highlight.material.dispose();
      }
      this.highlight = undefined;
    }
    if (this.popup) {
      this.popup.remove();
      this.popup = undefined;
    }
  }

  // read the origin through the host every time, so a reset while a popup is
  // open cannot leave a stale copy in closure state
  private center(): [number, number] {
    return this.host.center();
  }

  pickStatic(hit: THREE.Intersection, lngLat: LngLat) {
    const tileKey = (hit.object.userData.tileKey as string | undefined) ?? "";
    const point = hit.point;
    const originMeters = epsg4326toEpsg3857(this.center());
    const scaleFactor = scaleFactorAt(this.center()[1]);
    const hitKind = hit.object.userData.kind as string | undefined;
    if (hitKind === "custom_model") {
      const buildingId = hit.object.userData.buildingId as string | undefined;
      const info = (this.host.tiles.get(tileKey)?.objects.buildings ?? []).find(
        (candidate) => candidate.id === buildingId,
      );
      if (info) this.selectBuilding(info, lngLat);
      else this.clear();
      return;
    }
    const pick = hitKind ? this.pointPickers()[hitKind] : undefined;
    if (pick) {
      const info = pick.at(tileKey, point, originMeters, scaleFactor);
      if (info === undefined) this.clear();
      else pick.select(info, lngLat);
      return;
    }
    // fences and walls carry their own per-tile lines (the car collision data)
    if (hitKind === "fence" || hitKind === "wall") {
      const info = barrierAt(
        this.host.tiles.get(tileKey)?.objects.barriers ?? [],
        point,
        originMeters,
        scaleFactor,
        FEATURE_PICK_RADIUS[hitKind] ?? 4,
      );
      if (info) this.selectBarrier(info, lngLat);
      else this.clear();
      return;
    }
    // the generic layers (trees, benches, parks, rail, power, ...) share one
    // picker; the mesh kind maps to the feature kinds to search
    const featureKinds = hitKind ? FEATURE_PICK_KINDS[hitKind] : undefined;
    if (featureKinds) {
      const limit = Math.max(
        ...featureKinds.map((kind) => FEATURE_PICK_RADIUS[kind] ?? 6),
      );
      const info = featureAt(
        this.host.tiles.get(tileKey)?.objects.features ?? [],
        featureKinds,
        point,
        originMeters,
        scaleFactor,
        limit,
      );
      if (info) this.selectFeature(info, lngLat);
      else this.clear();
      return;
    }
    // A solar panel can sit under a pitched roof at the exact same spot, so
    // the roof wins the raycast even though the panel is what was clicked.
    // Give the mapped solar footprint precedence over the building below it.
    const solar = this.rooftopAt(tileKey, point, originMeters, scaleFactor);
    if (this.host.rooftopsVisible() && solar?.kind === "solar") {
      this.selectRooftop(solar, lngLat);
      return;
    }
    const candidates = this.host.tiles.get(tileKey)?.objects.buildings ?? [];
    // named `target` so it does not shadow the building() geometry builder
    let target = candidates.find((candidate) =>
      candidate.rings.some((ring) =>
        ringContains(ring, point, originMeters, scaleFactor),
      ),
    );
    if (!target) {
      // a roof/side hit can land just outside the footprint; take the nearest
      let best = 3;
      for (const candidate of candidates) {
        for (const ring of candidate.rings) {
          const distance = ringDistance(ring, point, originMeters, scaleFactor);
          if (distance < best) {
            best = distance;
            target = candidate;
          }
        }
      }
    }
    if (!target) {
      this.clear();
      return;
    }
    this.selectBuilding(target, lngLat);
  }

  // the point-feature pickers behind the click popups, keyed by every mesh kind
  // that resolves to one (a fountain has two meshes, a metro stop two). The
  // methods are bound here because the table is looked up rather than called.
  private pointPickers(): Record<string, Picker> {
    return {
      water: picker(this, this.waterAt, this.selectWater),
      furniture: picker(this, this.furnitureAt, this.selectFurniture),
      fountain: picker(this, this.fountainAt, this.selectFountain),
      fountain_water: picker(this, this.fountainAt, this.selectFountain),
      transit_stop: picker(this, this.transitAt, this.selectTransit),
      metro_sign: picker(this, this.transitAt, this.selectTransit),
      terrace: picker(this, this.terraceAt, this.selectTerrace),
      playground: picker(this, this.playgroundAt, this.selectPlayground),
      monument: picker(this, this.monumentAt, this.selectMonument),
      construction: picker(this, this.constructionAt, this.selectConstruction),
      crosswalk: picker(this, this.crosswalkAt, this.selectCrosswalk),
      platform: picker(this, this.platformAt, this.selectPlatform),
      rooftop: picker(this, this.rooftopAt, this.selectRooftop),
    };
  }

  // the water feature under a hit point: an area whose ring contains it, else
  // the nearest waterway centreline within the ribbon's half width
  private waterAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): WaterInfo | undefined {
    const candidates = this.host.tiles.get(tileKey)?.objects.water ?? [];
    const inside = candidates.find((w) =>
      w.rings.some((ring) =>
        ringContains(ring, point, originMeters, scaleFactor),
      ),
    );
    if (inside) return inside;
    let best: WaterInfo | undefined;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
      const threshold = waterwayWidth(candidate.kind) * 0.5 + 1;
      for (const line of candidate.lines) {
        const distance = ringDistance(
          line,
          point,
          originMeters,
          scaleFactor,
          false,
        );
        if (distance <= threshold && distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
    }
    return best;
  }

  // the furniture point nearest a hit on the merged tile mesh
  private furnitureAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): FurnitureInfo | undefined {
    return this.nearestPoint(
      this.host.tiles.get(tileKey)?.objects.furniture ?? [],
      point,
      originMeters,
      scaleFactor,
      3,
    );
  }

  private selectFurniture(info: FurnitureInfo, lngLat: LngLat) {
    this.clear();
    this.highlightAt(info.lon, info.lat, 1.3);

    const label = FURNITURE_LABELS[info.kind] ?? info.kind.replace(/_/g, " ");
    const lines = [
      `<strong>${escapeHtml(label)}</strong>`,
      osmLink(info.id),
    ].filter(Boolean);
    this.showPopup(lngLat, lines);
  }

  private fountainAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): FountainInfo | undefined {
    return this.nearestPoint(
      this.host.tiles.get(tileKey)?.objects.fountains ?? [],
      point,
      originMeters,
      scaleFactor,
      FOUNTAIN_PICK_RADIUS,
    );
  }

  private selectFountain(info: FountainInfo, lngLat: LngLat) {
    this.clear();
    // the ring hugs the basin, so a big fountain is ringed wider
    this.highlightAt(info.lon, info.lat, Math.max(1.5, info.size / 2 + 0.6));

    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      "Fountain",
      osmLink(info.id),
    ].filter(Boolean);
    this.showPopup(lngLat, lines);
  }

  private transitAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): TransitInfo | undefined {
    return this.nearestPoint(
      this.host.tiles.get(tileKey)?.objects.transit ?? [],
      point,
      originMeters,
      scaleFactor,
      6,
    );
  }

  private nearestPoint<T extends { lon: number; lat: number }>(
    candidates: T[],
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
    limit: number,
  ): T | undefined {
    let best: T | undefined;
    let bestSq = limit * limit;
    for (const info of candidates) {
      const m = toModelCoords([info.lon, info.lat], originMeters, scaleFactor);
      const dx = m[0] - point.x;
      const dy = m[1] - point.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestSq) {
        bestSq = distanceSq;
        best = info;
      }
    }
    return best;
  }

  private crosswalkAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): CrosswalkInfo | undefined {
    return this.nearestPoint(
      this.host.tiles.get(tileKey)?.objects.crosswalks ?? [],
      point,
      originMeters,
      scaleFactor,
      12,
    );
  }

  private selectCrosswalk(info: CrosswalkInfo, lngLat: LngLat) {
    this.clear();
    this.highlightAt(info.lon, info.lat, 4);

    const label = info.crossing?.includes("traffic_signals")
      ? "Zebra crossing at traffic lights"
      : "Zebra crossing";
    this.popup = new Popup({ closeButton: true, offset: 8, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML([label, osmLink(info.id)].join("<br>"))
      .addTo(this.host.map);
  }

  private rooftopAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): RooftopInfo | undefined {
    const candidates = this.host.tiles.get(tileKey)?.objects.rooftops ?? [];
    const inside = candidates.find((info) =>
      (info.rings ?? []).some((ring) =>
        ringContains(ring, point, originMeters, scaleFactor),
      ),
    );
    return (
      inside ??
      this.nearestPoint(candidates, point, originMeters, scaleFactor, 8)
    );
  }

  private selectRooftop(info: RooftopInfo, lngLat: LngLat) {
    this.clear();
    this.highlightAt(info.lon, info.lat, 5);
    const labels: Record<string, string> = {
      water_tower: "Water tower",
      chimney: "Chimney",
      antenna: "Antenna",
      solar: "Solar panels",
    };
    const label = labels[info.kind] ?? "Rooftop equipment";
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      label,
      osmLink(info.id),
    ].filter(Boolean);
    this.showPopup(lngLat, lines);
  }

  private platformAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): PlatformInfo | undefined {
    const candidates = this.host.tiles.get(tileKey)?.objects.platforms ?? [];
    const inside = candidates.find((info) =>
      info.rings.some((ring) =>
        ringContains(ring, point, originMeters, scaleFactor),
      ),
    );
    return (
      inside ??
      this.nearestPoint(candidates, point, originMeters, scaleFactor, 6)
    );
  }

  private selectPlatform(info: PlatformInfo, lngLat: LngLat) {
    this.clear();
    this.highlightAt(info.lon, info.lat, 6);
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      "Rail platform",
      osmLink(info.id),
    ].filter(Boolean);
    this.showPopup(lngLat, lines);
  }

  private constructionAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): ConstructionInfo | undefined {
    const candidates = this.host.tiles.get(tileKey)?.objects.construction ?? [];
    const inside = candidates.find((info) =>
      info.rings.some((ring) =>
        ringContains(ring, point, originMeters, scaleFactor),
      ),
    );
    if (inside) return inside;
    return this.nearestPoint(candidates, point, originMeters, scaleFactor, 30);
  }

  private selectConstruction(info: ConstructionInfo, lngLat: LngLat) {
    this.clear();
    this.highlightAt(info.lon, info.lat, 8);

    const labels: Record<string, string> = {
      residential: "Residential construction",
      apartments: "Apartment construction",
      commercial: "Commercial construction",
      industrial: "Industrial construction",
      office: "Office construction",
      parking: "Parking construction",
      building: "Construction site",
    };
    const label = (info.kind && labels[info.kind]) ?? "Construction site";
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      label,
      osmLink(info.id),
    ].filter(Boolean);
    this.showPopup(lngLat, lines);
  }

  private playgroundAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): PlaygroundInfo | undefined {
    return this.nearestPoint(
      this.host.tiles.get(tileKey)?.objects.playgrounds ?? [],
      point,
      originMeters,
      scaleFactor,
      12,
    );
  }

  private monumentAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): MonumentInfo | undefined {
    return this.nearestPoint(
      this.host.tiles.get(tileKey)?.objects.monuments ?? [],
      point,
      originMeters,
      scaleFactor,
      5,
    );
  }

  private selectPlayground(info: PlaygroundInfo, lngLat: LngLat) {
    this.clear();
    this.highlightAt(info.lon, info.lat, 7);
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      "Playground",
      osmLink(info.id),
    ].filter(Boolean);
    this.showPopup(lngLat, lines);
  }

  private selectMonument(info: MonumentInfo, lngLat: LngLat) {
    this.clear();
    this.highlightAt(info.lon, info.lat, 3);
    const labels: Record<string, string> = {
      statue: "Statue",
      bust: "Bust",
      plaque: "Plaque",
      stolperstein: "Stolperstein",
      war_memorial: "War memorial",
      sculpture: "Sculpture",
      stone: "Memorial stone",
      stele: "Stele",
      ghost_bike: "Ghost bike",
      obelisk: "Obelisk",
    };
    const label =
      (info.memorial && labels[info.memorial]) ??
      (info.kind === "monument" ? "Monument" : "Memorial");
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      label,
      osmLink(info.id),
    ].filter(Boolean);
    this.showPopup(lngLat, lines);
  }

  private terraceAt(
    tileKey: string,
    point: THREE.Vector3,
    originMeters: [number, number],
    scaleFactor: number,
  ): TerraceInfo | undefined {
    const candidates = this.host.tiles.get(tileKey)?.objects.terraces ?? [];
    let best: TerraceInfo | undefined;
    let bestSq = 25;
    for (const info of candidates) {
      const m = toModelCoords([info.lon, info.lat], originMeters, scaleFactor);
      const dx = m[0] - point.x;
      const dy = m[1] - point.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestSq) {
        bestSq = distanceSq;
        best = info;
      }
    }
    return best;
  }

  private selectTerrace(info: TerraceInfo, lngLat: LngLat) {
    this.clear();
    this.highlightAt(info.lon, info.lat, 2.2);

    const labels: Record<string, string> = {
      cafe: "Cafe terrace",
      restaurant: "Restaurant terrace",
      bar: "Bar terrace",
      pub: "Pub terrace",
      fast_food: "Fast-food terrace",
      ice_cream: "Ice-cream terrace",
      biergarten: "Beer garden",
    };
    const label = labels[info.kind] ?? "Outdoor terrace";
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      label,
      osmLink(info.id),
    ].filter(Boolean);
    this.showPopup(lngLat, lines);
  }

  // All the popups share the same chrome; only the body differs. An empty body
  // means "nothing worth saying", so those clicks leave the map alone. Returns
  // the popup so callers that wire extra controls can skip the null check.
  showPopup(lngLat: LngLatLike, lines: (string | null)[]): Popup | undefined {
    const body = lines.filter(Boolean);
    if (body.length === 0) return undefined;
    this.popup = new Popup({ closeButton: true, offset: 8, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML(body.join("<br>"))
      .addTo(this.host.map);
    return this.popup;
  }

  // a lon/lat point in model space, ringed on the ground. Every select* for a
  // point feature needs exactly this, and it was copy-pasted a dozen times.
  private highlightAt(lon: number, lat: number, radius: number): void {
    const originMeters = epsg4326toEpsg3857(this.center());
    const scaleFactor = scaleFactorAt(this.center()[1]);
    const [x, y] = toModelCoords([lon, lat], originMeters, scaleFactor);
    this.highlightPoint(x, y, radius);
  }

  private highlightPoint(x: number, y: number, radius: number): void {
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < 32; i++) {
      const angle = (i / 32) * Math.PI * 2;
      ring.push(
        new THREE.Vector3(
          x + Math.cos(angle) * radius,
          y + Math.sin(angle) * radius,
          0.12,
        ),
      );
    }
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(ring),
      new THREE.LineBasicMaterial({
        color: 0xffcc00,
        depthTest: false,
        transparent: true,
      }),
    );
    outline.renderOrder = 999;
    this.host.scene.add(outline);
    this.highlight = outline;
  }

  private selectTransit(info: TransitInfo, lngLat: LngLat) {
    this.clear();
    this.highlightAt(info.lon, info.lat, 2.6);

    const labels: Record<string, string> = {
      metro: "Metro entrance",
      bus: "Bus stop",
      tram: "Tram stop",
    };
    const label = labels[info.kind] ?? "Transit stop";
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      label,
      osmLink(info.id),
    ].filter(Boolean);
    this.showPopup(lngLat, lines);
  }

  private selectWater(info: WaterInfo, lngLat: LngLat) {
    this.clear();
    const label = info.kind
      ? info.kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
      : "Water";
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      escapeHtml(label),
      osmLink(info.id),
    ].filter(Boolean);
    this.showPopup(lngLat, lines);
  }

  // a generic OSM feature: points get a ring, areas and lines just the popup
  private selectFeature(info: FeatureInfo, lngLat: LngLat) {
    this.clear();
    if (info.lon !== undefined && info.lat !== undefined) {
      const originMeters = epsg4326toEpsg3857(this.center());
      const scaleFactor = scaleFactorAt(this.center()[1]);
      const [x, y] = toModelCoords(
        [info.lon, info.lat],
        originMeters,
        scaleFactor,
      );
      const radius = info.kind === "tree" || info.kind === "bench" ? 1.5 : 3;
      this.highlightPoint(x, y, radius);
    }
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      escapeHtml(this.featureLabel(info)),
      osmLink(info.id),
    ].filter(Boolean);
    this.showPopup(lngLat, lines);
  }

  // fences and walls are features too; reuse the generic popup
  private selectBarrier(info: BarrierInfo, lngLat: LngLat) {
    this.selectFeature(
      {
        id: info.id,
        name: info.name,
        kind: info.kind,
        subtype: info.subtype,
        lines: [info.coords],
      },
      lngLat,
    );
  }

  private featureLabel(info: FeatureInfo): string {
    switch (info.kind) {
      case "tree":
        return info.subtype === "conifer" ? "Conifer" : "Tree";
      case "tree_row":
        return "Tree row";
      case "bench":
        return "Bench";
      case "green":
        // a pitch keeps its green style but deserves its own name
        if (info.sport) {
          const sport = pitchSportOf(info.sport);
          return (sport && PITCH_LABELS[sport]) ?? "Sports pitch";
        }
        return info.subtype === "dense" ? "Park" : "Green area";
      case "cemetery":
        return "Cemetery";
      case "rail":
        return info.subtype === "tram" ? "Tram line" : "Railway";
      case "park_path":
        return info.subtype === "bike" ? "Cycle path" : "Footpath";
      case "power_tower":
        return "Power tower";
      case "power_line":
        return "Power line";
      case "bridge":
        return info.subtype === "railway" ? "Rail bridge" : "Bridge";
      case "tunnel":
        return "Tunnel portal";
      case "gate":
        return "Gate";
      case "aeroway":
        return info.subtype === "runway"
          ? "Runway"
          : info.subtype === "taxiway"
            ? "Taxiway"
            : info.subtype === "apron"
              ? "Apron"
              : "Helipad";
      case "road_marking":
        return info.subtype === "signal"
          ? "Traffic signal marking"
          : info.subtype === "give_way"
            ? "Give-way line"
            : "Stop line";
      case "wall": {
        const labels: Record<string, string> = {
          retaining_wall: "Retaining wall",
          city_wall: "City wall",
          hoarding: "Hoarding",
        };
        return labels[info.subtype ?? ""] ?? "Wall";
      }
      case "fence": {
        const labels: Record<string, string> = {
          guard_rail: "Guard rail",
          railing: "Railing",
        };
        return labels[info.subtype ?? ""] ?? "Fence";
      }
      default:
        return info.kind.replace(/_/g, " ");
    }
  }

  selectBuilding(info: BuildingInfo, lngLat: LngLatLike) {
    this.clear();
    const originMeters = epsg4326toEpsg3857(this.center());
    const scaleFactor = scaleFactorAt(this.center()[1]);

    // outline: base + top loops and verticals for each ring
    const positions: number[] = [];
    for (const ring of info.rings) {
      const pts = ring.map((c) => toModelCoords(c, originMeters, scaleFactor));
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        positions.push(a[0], a[1], 0.3, b[0], b[1], 0.3);
        positions.push(a[0], a[1], info.height, b[0], b[1], info.height);
        positions.push(a[0], a[1], 0.3, a[0], a[1], info.height);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    const outline = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color: 0xffcc00,
        depthTest: false,
        transparent: true,
      }),
    );
    outline.renderOrder = 999;
    this.host.scene.add(outline);
    this.highlight = outline;

    const address = [info.housenumber, info.street].filter(Boolean).join(" ");
    const imputed = new Set(info.imputed);
    const mark = (field: string) =>
      imputed.has(field) ? ' <span class="imputed">imputed</span>' : "";
    const swatch = (color: string | undefined) =>
      color
        ? `<span class="swatch" style="background:${escapeHtml(color)}"></span>`
        : "";
    const lines = [
      info.name ? `<strong>${escapeHtml(info.name)}</strong>` : null,
      address ? escapeHtml(address) : null,
      `Height: ${info.height.toFixed(1)} m`,
      info.color
        ? `Wall: ${swatch(info.color)}${escapeHtml(info.color)}${mark("color")}`
        : null,
      info.roofShape
        ? `Roof: ${escapeHtml(info.roofShape)}${mark("roof_shape")}`
        : null,
      info.roofColor
        ? `Roof color: ${swatch(info.roofColor)}${escapeHtml(info.roofColor)}${mark("roof_color")}`
        : null,
      osmLink(info.id),
      `<a href="#" data-gltf class="gltf-link" title="Download GLTF">G</a>`,
      `<a href="#" data-zoom>Zoom to building</a>`,
    ].filter(Boolean);
    const popup = this.showPopup(lngLat, lines);
    const link = popup
      ?.getElement()
      ?.querySelector("[data-zoom]") as HTMLElement | null;
    link?.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      this.zoomToBuilding(info);
    });
    const gltfLink = popup
      ?.getElement()
      ?.querySelector("[data-gltf]") as HTMLElement | null;
    gltfLink?.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      void this.downloadBuildingGLTF(info);
    });
  }

  private saveBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private async downloadBuildingGLTF(info: BuildingInfo) {
    const safe =
      (info.id ?? info.name ?? "building").replace(/[^a-z0-9._-]+/gi, "_") ||
      "building";
    if (info.model?.asset) {
      try {
        const response = await fetch(`tiles/${info.model.asset}`);
        if (!response.ok) throw new Error(`asset HTTP ${response.status}`);
        this.saveBlob(await response.blob(), `${safe}.glb`);
      } catch (error) {
        console.warn("building model download failed", error);
      }
      return;
    }
    const originMeters = epsg4326toEpsg3857(this.center());
    const scaleFactor = scaleFactorAt(this.center()[1]);
    const feature: Geojson.Feature = {
      type: "Feature",
      id: info.id,
      properties: {
        color: info.color,
        height: info.height,
        base: info.base,
        roof_shape: info.roofShape,
        roof_color: info.roofColor,
        solar: info.solar,
        building: info.building,
        religion: info.religion,
        glass: info.glass,
      },
      geometry: info.geometry ?? {
        type: "Polygon",
        coordinates: info.rings,
      },
    };
    const parts = building(originMeters, scaleFactor, feature);
    const group = new THREE.Group();
    group.name = info.name ?? info.id ?? "building";
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0,
    });
    for (const part of parts) {
      group.add(new THREE.Mesh(part.walls, material));
      if (part.roof) group.add(new THREE.Mesh(part.roof, material));
    }
    try {
      const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        new GLTFExporter().parse(
          group,
          (result) => {
            if (result instanceof ArrayBuffer) resolve(result);
            else reject(new Error("GLTF exporter returned JSON, not binary"));
          },
          reject,
          { binary: true },
        );
      });
      this.saveBlob(
        new Blob([buffer], { type: "model/gltf-binary" }),
        `${safe}.glb`,
      );
    } catch (error) {
      console.warn("building GLTF export failed", error);
    }
  }

  private zoomToBuilding(info: BuildingInfo) {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const ring of info.rings) {
      for (const [lon, lat] of ring) {
        minLon = Math.min(minLon, lon);
        minLat = Math.min(minLat, lat);
        maxLon = Math.max(maxLon, lon);
        maxLat = Math.max(maxLat, lat);
      }
    }
    this.host.map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      { maxZoom: 19, duration: 700, padding: 60 },
    );
  }
}
