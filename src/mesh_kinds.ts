// Every mesh kind a tile can produce. This list is the one place a kind is
// declared: the material table, the line kinds, the shadow list, the pickable
// kinds and the layer checkboxes are all keyed by it, so a kind that appears in
// one table and not another is a type error instead of a layer that silently
// renders with the wrong material (which is how roofs ended up with the tree
// sway shader).
//
// A kind is not a cmtype: `tree_row` and `power_line` are tile tags that map to
// the `tree` and `power_wire` meshes, and one tag can produce several kinds
// (a building produces walls, a roof, and sometimes a church cross).
export const MESH_KINDS = [
  "aeroway",
  "bench",
  "bridge",
  "building",
  "cemetery",
  "church",
  "construction",
  "crosswalk",
  "fence",
  "fountain",
  "fountain_water",
  "furniture",
  "gate",
  "glass",
  "green",
  "lane",
  "metro_sign",
  "monument",
  "park_path",
  "pitch",
  "pitch_paint",
  "platform",
  "playground",
  "power_tower",
  "power_wire",
  "rail",
  "road_marking",
  "roof",
  "rooftop",
  "sidewalk",
  "terrace",
  "transit_stop",
  "tree",
  "tunnel",
  "wall",
  "water",
] as const;

export type MeshKind = (typeof MESH_KINDS)[number];

// Scene kinds that are not produced by a tile builder: the scene layers that
// own their own meshes (parked cars, the fleet bodies, the facade detail, the
// night sprites) and a city-profile GLTF, which replaces a building's volume
// and carries its own materials. Everything that reads `userData.kind` off a
// scene object accepts these too, so the perf counters keep reporting them as
// their own bucket instead of lumping them into "other".
export const SCENE_ONLY_KINDS = [
  "airplane",
  "custom_model",
  "driving_car",
  "facade",
  "floodlight",
  "floodlight_mast",
  "floodlight_pool",
  "lamplight",
  "lamp_pool",
  "lamppost",
  "parked_car",
  "signal_light",
  "signal_post",
] as const;

export const SCENE_KINDS = [...MESH_KINDS, ...SCENE_ONLY_KINDS] as const;

export type SceneKind = (typeof SCENE_KINDS)[number];

const MESH_KIND_SET: ReadonlySet<string> = new Set(MESH_KINDS);

/** Narrows a scene kind to one a tile builder can produce. */
export function isMeshKind(kind: SceneKind): kind is MeshKind {
  return MESH_KIND_SET.has(kind);
}

/**
 * The kind tag on a scene object, or undefined when it is not one this module
 * knows. Reading `userData.kind` raw would let any string through, and the
 * tables keyed by kind would then quietly miss it.
 */
export function asSceneKind(value: unknown): SceneKind | undefined {
  if (typeof value !== "string") return undefined;
  return (SCENE_KINDS as readonly string[]).includes(value)
    ? (value as SceneKind)
    : undefined;
}
