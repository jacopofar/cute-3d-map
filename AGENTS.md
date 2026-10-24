# AGENTS.md

Project instructions for agents working in this repo — a MapLibre + Three.js
demo that renders OSM-derived 3D buildings, trees and vehicles, plus a
decorative volumetric cloud layer.

## Language and writing

- **US English spelling** in prose, comments, identifiers and docs: `color`,
  `center`, `meter`, `gray`, `normalize`, `behavior`, `catalog`. No British
  spellings.
- **Comments are in English.** They may be expressive (surprise, annoyance,
  delight) and may sprinkle in an Italian or German word when it fits.
- Prefer comments that explain **why** — the tradeoff, the rejected
  alternative, the perf reason — over describing what the next line does.
- No emoji in code, comments or docs.
- Don't "fix" literal external keys: OSM tags like `building:colour` /
  `roof:colour` keep their spelling because they are data.

## Commits

- Imperative, single-line subject in sentence case; no `feat:` / `fix:` prefixes.
- Add a short body only when the "why" isn't obvious.
- Keep unrelated reformatting out of a feature commit.

## Build, test, verify

- `npm run dev` — Vite dev server (needs `VITE_MAPTILER_KEY` in `.env`).
- `npm run test:check` — type check plus the unit suite without coverage, the
  default per-change loop (~5 s).
- `npm run build` — type check plus production build.
- `npm run test:unit` — vitest for the pure modules, with coverage (~4 s).
- `npm run test:e2e:changed` — Playwright specs selected from the diff against
  `main`; the default per-change e2e (~30-90 s). `--list` previews the selection.
- `npm run test:e2e:smoke` — boot and permalink specs only.
- `npm run test:e2e` — full Playwright suite (~5 min; the merge gate).
- `npm run bench` — frame-time benchmark (slow, machine-dependent; see README).
- `npm run bench:gpu` — the same app in headed Chrome on the real GPU (needs a
  display), panning/tilting/zooming (~80 s); writes
  `perf-results/latest-gpu.json`. Run it only for render/perf changes.
- `npm run prettify` — Prettier over `src/**.ts`. It also reformats unrelated
  lines, so prefer formatting only the files you touched.

Per change, run `npm run test:check` and `npm run test:e2e:changed`. Run the full
`npm run test:e2e` before merging, and after a tilegen change (it can affect every
layer). `uv run pytest` in `tilegen/` reports coverage (`--cov`, floor 80%).

## Architecture

- `src/main.ts` — `CoolMap` wraps the MapLibre map and adds the Three.js
  `CustomLayerInterface`. Loads/unloads tiles within a 3-tile margin of the
  center (`loadUnloadCoord`), debounced 150 ms. The map carries its view in a
  `#map=zoom/lat/lon` permalink (`hash: "map"`, so MapLibre reads and writes it)
  and the projection origin is seeded from wherever the map opens. The scene
  lights, sun shadows (a 2 km cascade following the view, received only by the
  ground catcher), sky/fog, the dawn/dusk grade and the night-light visibility
  are driven from `applyLighting()`.
- `src/geojson_data.ts` — fetches `tiles/{x}/{y}.json`, converts features to
  Three.js geometry via `src/elements3d/`, and merges one `BufferGeometry` per
  kind per tile (vertex colors, so a tile is a handful of draw calls).
- `src/elements3d/facade_layout.ts` / `facade.ts` — procedural window, balcony
  and door detail. The layout is pure maths (seeded, unit-tested); `facade.ts`
  turns it into one merged geometry per tile (quads wound to match their normal,
  since OSM rings come in both windings). `CoolMap` builds it only above zoom 17
  and only for the tiles around the center (`loadedDetail`), and drops it when
  zoomed out or when the origin resets.
- `src/elements3d/water.ts` — lakes, ponds and reservoirs as flat polygons and
  rivers/canals/streams as flat ribbons at ground level, drawn by one animated
  `ShaderMaterial` (procedural ripples, `uTime` advanced each frame). A negative
  OSM `layer` (underwater) fades the feature to `UNDERWATER_OPACITY` via a
  per-vertex `aFade`. tilegen clips water to the tile (a lake spans many tiles),
  unlike buildings; water is its own per-tile mesh (kind `water`), so the
  checkbox is a visibility switch.
- `src/elements3d/cemetery.ts` / `tombstone_rows.ts` — cemeteries
  (`landuse=cemetery`, `amenity=grave_yard`) as procedural rows of simple
  tombstones over the basemap ground. tilegen clips the area like a park and
  emits `cmtype=cemetery`; OSM rarely maps the individual graves, so the layout
  is pure maths (aligned to the longest wall, inset from the boundary, seeded
  gaps, capped with wider spacing), unit-tested in `tombstone_rows.test.ts`.
  The stones are one merged Lambert mesh per tile (kind `cemetery`), and there
  is no 3D ground, so the basemap's cemetery paths stay visible.
- `src/elements3d/furniture.ts` / `box_builder.ts` — street furniture
  (bollards, bins, bike racks, post boxes, drinking fountains, info boards,
  hydrants) as merged low-poly props. tilegen emits a point with a `furniture`
  kind; areas collapse to a centroid and a line keeps its bearing for a kerb-side
  rack. One Lambert mesh per tile (kind `furniture`), no shadows; benches stay
  their own layer because they carry a facing and a checkbox.
- `src/elements3d/transit.ts` — metro entrances, tram stops and bus stops in the
  Milan look: a dark stair opening and an "M" totem for the metro (the white/red
  M sign is its own textured mesh per tile, crossed so it reads from every
  side), a yellow palina and an optional shelter for buses/trams. Bodies merge
  into one Lambert mesh per tile (kind `transit_stop`); the signs are the
  separate `metro_sign` kind. Clickable with the OSM link. Platforms and rails
  are not in this pass.
- `src/elements3d/crosswalk.ts` — marked `highway=crossing` nodes as white zebra
  bars along the road, repeated across it, using the tile's `bearing` and
  `width`; merged per tile (kind `crosswalk`), clickable. The plain `crossing`
  point stays data-only for the cosmetic traffic slowdown.
- `src/elements3d/road_marking.ts` — stop lines and lane arrows for
  `highway=stop`/`give_way`/`traffic_signals` nodes, using the tile's approach
  directions, width, lanes and `turn:lanes`; merged per tile (kind
  `road_marking`), no popup. A two-way road gets the line on the right half,
  a one-way road the full width; arrows appear only on multi-lane approaches.
- `src/elements3d/rooftop.ts` — mapped water towers, chimneys, antennas and
  solar generators placed on the carrying building's roof (`base` from
  tilegen); a solar polygon keeps its footprint as a flat panel surface, a
  solar point becomes a small array. A building with solar panels keeps a flat
  top so the panels stay visible. All are clickable with the OSM link; one
  merged Lambert mesh per tile (kind `rooftop`), `#rooftop-toggle`.
- `src/elements3d/park_path.ts` — foot/cycle paths clipped by tilegen to the
  tile's green union, drawn as flat ribbons above the green shader. The color
  comes from `surface` when mapped, else light brown for walk and brick red for
  bike; one merged Lambert mesh per tile (kind `park_path`),
  `#park-paths-toggle`. Mapped `footway=sidewalk` ways are excluded.
- `src/elements3d/power.ts` — `power=tower` pylons and clipped overhead
  `power=line`/`minor_line` spans. Towers merge into one Lambert mesh per tile
  (kind `power_tower`); wires are one `LineSegments` per tile (kind
  `power_wire`) with a catenary sag, shared `#power-lines-toggle`. Underground
  and tunnel sections are skipped by tilegen.
- `src/elements3d/wall.ts` / `gate.ts` — low solid walls from `barrier=wall` /
  `wall=*` ways and gate nodes as two posts plus a leaf, oriented by the nearest
  wall. One merged Lambert mesh per tile each (kinds `wall` and `gate`),
  `#walls-toggle`, no shadows.
- `src/elements3d/sidewalk.ts` — sidewalk polygons authored by tilegen
  (`sidewalk` kind): a 0.14 m slab with darker kerb faces, one mesh per tile,
  `#sidewalks-toggle`, gated at zoom 16. Mapped `footway=sidewalk` ways and
  procedural road-side strips are unioned in tilegen.
- `src/elements3d/platform.ts` — clipped rail/tram platforms raised into a
  concrete slab with a white edge, one Lambert mesh per tile; line platforms
  are buffered to a 4 m ribbon by tilegen. Clickable with the name and OSM link.
- `src/elements3d/rail.ts` — above-ground rail and tram ways: ballast, two
  rails, sleepers and catenary poles/wires for heavy rail; two embedded rails
  for trams. One merged mesh per tile (kind `rail`); tunnels, covered sections
  and bridges are skipped by tilegen.
- `src/elements3d/construction.ts` — clipped `landuse=construction` sites as
  dirt/gravel ground with containers, a material stack and one to three
  procedural tower cranes on the centroid tile; merged per tile (kind
  `construction`), clickable. No shadows; `building=construction` stays a normal
  building.
- `src/elements3d/playground.ts` — `leisure=playground` as a sand/rubber patch
  with a swing, slide, spring rider and (for wider patches) a climbing frame,
  merged per tile (kind `playground`), clickable. No shadows.
- `src/elements3d/monument.ts` — `historic=monument`/`memorial` and
  `man_made=obelisk` as a pedestal/statue, bust, obelisk, war memorial, stele,
  plaque or Stolperstein, chosen from `kind`/`memorial`; merged per tile (kind
  `monument`), clickable. No shadows.
- `src/elements3d/terrace.ts` — outdoor seating for cafes/restaurants/bars tagged
  `outdoor_seating`: tilegen moves the point to the nearest road point outside
  the building footprint, and the frontend draws one or two umbrellas with tables
  and chairs, merged per tile (kind `terrace`), clickable with the OSM link.
- `src/elements3d/fountain.ts` — `amenity=fountain` as a low stone basin with a
  water surface and, for larger ones, a central pedestal, bowl and jet. tilegen
  emits a point with the equivalent diameter of a mapped area (clamped). Stone
  and water are separate per-tile meshes: `fountain` (Lambert) and
  `fountain_water` (a small animated shader with ripples and jet bands, dimmed at
  night). Clicking either rings the basin and shows the OSM link.
- `src/elements3d/bridge.ts` — bridges and tunnels. A bridge way becomes a
  raised slab (deck + parapets, both ends ramped to the ground) and a
  `man_made=bridge` footprint a flat deck slab; a tunnel becomes a dark portal
  frame at each true way end. tilegen clips a bridge to the tile (like water) and
  emits tunnel ends as portal Points; the underground part is not drawn. Each is
  its own per-tile mesh (kinds `bridge` and `tunnel`), so the single "bridges &
  tunnels" checkbox is a visibility switch.
- `src/main.ts` building popup — the **G** button exports the clicked building's
  walls and roof as a `.glb` via Three.js `GLTFExporter`; `BuildingInfo` keeps
  the source geometry for an exact footprint.
- `src/elements3d/roof_layout.ts` / `roof.ts` — the roof over each footprint,
  drawn as its own mesh per tile (kind `roof`) so the roof-shapes checkbox is a
  visibility switch. The shape comes from the tile's `roof_shape`; the layout is
  pure maths and unit-tested. Footprints with an inner ring, a concave outline,
  or more than `MAX_ROOF_VERTICES` (8) corners stay flat, as the ridge fan breaks
  up on them; that flat fallback is the extrusion's top cap, colored with the
  real or imputed `roof_color`. `src/elements3d/random.ts` holds the seeded PRNG and hash shared by
  the facade and roof code.
- `src/elements3d/church.ts` — the church look. `isChurch` classifies a
  building from the tile's `building`/`religion` tags (tilegen only reports
  them: a church is an ordinary `building=*` polygon). A church whose color OSM
  left out takes a seeded stone/ochre wall and a slate roof, its roof is forced
  gabled and `CHURCH_PITCH` (1.3x) steeper, and `church()` builds a gold cross
  on the ridge from the same `roofPlan` the roof uses, so it neither floats nor
  sinks; a footprint too complex to roof keeps its flat cap and the cross stands
  just above it. The cross is its own per-tile kind (`church`), so its checkbox
  hides just the ornament.
- `src/traffic.ts` — `TrafficRenderer`: stateless renderer of the precomputed
  routes; one instance per fleet (`CAR_TRAFFIC`, `TRAIN_TRAFFIC`, `BUS_TRAFFIC`,
  `TRAM_TRAFFIC`). It places a slice of vehicles per update at ~30 Hz (spread
  over frames) and culls runs outside the map bounds, so the CPU only samples
  what is on screen; positions stay a pure function of time. `pick()` raycasts
  the visible instances and returns the loop's GTFS `meta` for the click popup;
  `positionAt()` gives the camera follow its exact drawn lon/lat/heading.
- `src/parking_layout.ts` — walks the tile's authored parking rows (kerb line,
  style, pitch, side, occupancy) and places the occupied cars in model space.
  Pure and unit-tested; `geojson_data` turns the result into `ParkedCar`s.
- `src/parked_cars.ts` — static parked cars. The placed cars become one
  InstancedMesh per tile, sized to that tile's spots and bounded so it culls
  when off screen. The layer
  diffs the 3x3 center window (`diffParkedTiles`): a tile that enters is built, a
  tile that leaves is disposed (instance buffers only; the geometry and material
  stay shared), and a tile that stays with the same spot array is untouched. An
  origin reset rebuilds every resident tile, since coordinates are relative to
  the origin. It follows the facade gate: above `FACADE_MIN_ZOOM` and only for
  the 3x3 tiles around the center, so it holds ~60k instances rather than the
  ~370k of the whole loaded window; up to 9 draw calls instead of 1, but each
  culls separately. `#parked-cars-toggle` is a plain visibility switch. Uses a
  lit material (unlike the moving fleet's unlit basic one), so parked cars
  darken at night.
- `src/driving.ts` / `src/driving_car.ts` / `src/collision.ts` — car mode, the
  **Drive** button's free-driving car. `driving.ts` is the pure arcade model
  (accelerate/brake, a speed-scaled bicycle turn, lon/lat integration in
  substeps) and takes an optional `blocked` predicate: a blocked substep tries
  the east and north axes separately, so the car slides along a wall instead of
  sticking, and an already-overlapping car may drive out. `collision.ts` is the
  pure geometry (the car rectangle, point-in-ring, segment/rectangle tests);
  `driving_car.ts` owns the single mesh. `main.ts` supplies the obstacles from
  the tile data: building footprint rings and fence/wall lines for the 3x3
  tiles around the car, with precomputed bboxes; a hidden fence/wall layer does
  not block and a building part based above the car is overhead. The camera
  chases the car with MapLibre `jumpTo` (bearing = heading, fixed zoom/pitch,
  looking a little ahead), so map gestures are disabled while driving and the
  mode runs its own slower tile pass (the per-frame jump keeps the 150 ms move
  debounce from ever firing). The car spawns on the nearest loaded car route and
  reports `drive-start` / `drive-stop` perf events. No road graph and no physics
  beyond the rectangle collision.
- `src/night_lights.ts` — the night light sources: street lamps (`lamps` tile
  block) and traffic-signal heads (`signals` from the signal Points). Warm lamp
  sprites plus a wider ground "pool", red/green signal sprites on the global 8 s
  light, all on a thin instanced post. One draw call per layer; visible at night
  above `NIGHT_LIGHT_MIN_ZOOM` (15), and only for the 3x3 centre tiles. The
  `#lampposts-toggle` checkbox hides the lamps/pools/posts only; signal heads
  stay.
- `src/daynight.ts` — the approximate solar model (Milan, local mean solar
  time): sun altitude/azimuth, key/fill/hemisphere colors, sky and fog colors,
  dawn/dusk warmth and the screen grade. Pure and unit-tested.
- `src/clouds.ts` — decorative volumetric cloud layer (disabled above a zoom).
- `tilegen/` — Python (uv, ruff, ty) offline tile generator; output lands in
  `public/tiles/{x}/{y}.json`.
- `tilegen/geo.py` — slippy-tile helpers shared by the generator.
- `tilegen/city.py` — optional city profile loader/validator
  (`cities/<name>/city.json`, `buildings.json`, `areas.geojson`,
  `vehicles.json`). Applies building color/roof/facade overrides, polygon-area
  building overrides, GTFS line colors/body lengths and GLTF model replacements;
  missing files keep the Milan defaults. `vehicles.json` supports
  `default_color`, `by_line` and `by_route_id`; a line/route value is a color or
  `{ "color", "length" }`, and the frontend scales the fleet body to the loop's
  `vehicle_length`. Model files are copied into the tile's `{y}_assets/` folder
  and loaded by the frontend.
- `tilegen/features.py` — pure OSM-tag predicates and tile feature builders
  (`to_building`, `to_water`, `to_park_path`, ...). No parquet I/O; the loaders
  and pipeline import it.
- `tilegen/loaders.py` — parquet/DuckDB loaders and per-tile authoring helpers
  (parking rows, sidewalks, rooftop gear, road data).
- `tilegen/pipeline.py` — tile assembly and serialization; `tile_to_geojson`,
  `parquet_to_tiles` and the fleet/report stages.
- `tilegen/impute.py` — fills a building's missing color/roof tags by sampling
  the distribution of the values that ARE present (seeded per building, so a
  rebuild reproduces the tiles). Pure: it takes counts and tag mappings, so it
  is unit-tested like `traffic.py`.
- `tilegen/traffic.py` — precomputes vehicle routes: global graph, loop
  generation (`random` three-point loops for cars, planar `faces` for trains),
  per-tile split. Per-fleet configs (`CAR_CONFIG`, `TRAIN_CONFIG`) drive cars
  and trains, and `loop_report` / `loops_to_geojson` build the loop report.
  Takes plain `Way` inputs and does no OSM I/O itself (`loaders.load_ways` reads
  the parquet), so it is dependency-free and unit-tested in `tilegen/tests/`.
  A loop may carry `meta` (GTFS line/route/headsign); it survives the cache and
  the per-tile traffic block.
- `tilegen/tile_inspector.py` — flat SVG/PNG inspector for an area of generated
  tiles. Reads `public/tiles/{x}/{y}.json`, draws one logical color per
  `cmtype` with no basemap or decoration; Pillow is only needed for PNG.
- `tilegen/gtfs_routes.py` — diagnostic exporter for GTFS route shapes. Writes
  one GeoJSON feature per bus/tram shape with direction counts, headsigns,
  length, closed flag and reverse-pair id, plus a Markdown summary. When tilegen
  runs with both `--gtfs` and `--report`, `pipeline._traffic_layers` calls this
  into the report directory automatically.
- `tilegen/gtfs.py` — optional GTFS zip reader. Uses the feed's shapes as
  one-way bus/tram loops in the feed direction (route types 3/11 and 0), uses
  `stop_times.txt` for segment travel times and stop dwell, assigns vehicles
  with `BUS_GTFS_CONFIG`/`TRAM_GTFS_CONFIG`, and attaches line/route/headsign
  metadata for the moving-vehicle popup. The feed is opt-in via `--gtfs`; the
  default OSM rail logic remains when it is absent.
- `tilegen/features.py` walls/gates — `WALL_BARRIERS`, `GATE_BARRIERS`,
  `to_wall`, `to_gate`; gate nodes get their bearing from the nearest wall way
  (`loaders.load_gate_bearings`). Walls clip like fences.
- `tilegen/sidewalks.py` — authors sidewalk centre lines from car roads
  (default both sides; explicit `sidewalk:left/right`, `sidewalk` and
  `sidewalk=separate` honoured) and feeds mapped `footway=sidewalk` ways into
  the same polygon union. Width from `sidewalk:side:width`/`sidewalk:width`,
  default 2 m (1.5 m service). `main.sidewalk_polygons_by_tile` buffers, unions,
  subtracts road surfaces and closes corner gaps.
- `tilegen/parking.py` — authors static parking: one kerb row per side of every
  parking-eligible highway, at a pitch set by a seeded style (`parallel`,
  `perpendicular`, `fishbone`), 95% occupancy. Skips motorways/trunks/links,
  roundabouts and ways under `MIN_WAY_LENGTH`; rows are clipped per tile by
  `main.parking_rows_by_tile`. Overlapping rows are deduped at
  `MIN_SPOT_SPACING`, the higher road class winning. A row end within
  `JUNCTION_DISTANCE` of another car road is trimmed by `JUNCTION_TRIM`, so
  parking stops before junctions; pedestrian areas are not included. Pure (plain `ParkingWay`
  inputs; `main.load_parking_ways` reads the parquet), so it is unit-tested like
  `traffic.py`. `main.outside_cemeteries` drops ways whose midpoint is inside a
  cemetery, so the grave paths do not fill with cars.
- `tilegen/lamps.py` — street lamps for the night glow: one every `LAMP_SPACING`
  (55 m) on both sides of every parking-eligible road, just beyond the kerb,
  grouped per tile. Pure and unit-tested; uses the same `ParkingWay` inputs.

## Domain lexicon

- **tile** — a `public/tiles/{x}/{y}.json` file at `TILE_ZOOM` (15).
- **tile key** — the `x_y` string used in `loadedTiles` / `pendingTiles`.
- **origin** — the projection origin (`tileCenter`) in EPSG:3857; model
  coordinates are meters relative to it, scaled by `cos(latitude)`.
- **origin reset** — recentering the origin when the view drifts more than 2
  tiles from it.
- **render margin** — how many tiles beyond the center tile stay loaded (3).
- **cmtype** — the per-feature kind tag in a tile: `building`, `tree`,
  `tree_row`, `water`, `cemetery`, `furniture`, `fountain`, `transit_stop`,
  `terrace`, `playground`, `monument`, `construction`, `crosswalk`,
  `road_marking`, `platform`, `rail`, `park_path`, `power_tower`, `power_line`,
  `traffic_signal`, `crossing` (the road/rail network is not emitted; routes
  come from `traffic`). A `building:part` is still `cmtype: "building"`, with a
  `base` elevation.
- **building part** — a `building:part=*` footprint drawn like a building but
  starting at its `min_height`/`min_level` instead of the street. `height` is
  the top elevation; without it, `max_level` or `building:levels` gives the
  height. Its facade detail is offset by the same base.
- **church** — a building whose tile tags make `isChurch` true (`building` is
  church/chapel/cathedral/..., or a place of worship with a Christian religion).
  It is also the name of the per-tile kind holding just its cross, so the
  church-crosses checkbox leaves the walls to the building layer.
- **fleet** — a `TrafficRenderer`; everything the traffic block holds.
- **loop** — a closed walk of the road (or rail) graph; the unit of precomputed
  traffic.
- **method** — how a fleet builds loops: `random` (cars: shortest paths through
  three random nodes) or `faces` (trains: planar faces of the graph).
- **kind** — a loop/vehicle tag, `car`, `train`, `bus` or `tram`; picks the
  fleet and body. GTFS loops also carry a `meta` block for the popup.
- **run** — the piece of a loop that falls inside one tile, with `[t0, t1)`
  seconds into the loop's `period` and a `times` keyframe per coordinate.
- **phase** — a vehicle's 0..1 offset along its loop; vehicles are spread
  `k/n` so spacing is even.
- **period** — seconds for one lap of a loop (the sum of its seg times, since
  speeds vary along it); the client samples the run by `(t + phase * period) %
  period`.
- **speed** — per edge: the `maxspeed` tag when present, else the highway-class
  default; clamped to a sane range.
- **crossing / traffic signal** — an OSM `highway=crossing` or
  `highway=traffic_signals` node. Both are emitted as point tiles and in the
  debug GeoJSON; the frontend slows vehicles as they pass over them.
- **facade detail** — the procedural windows, balconies and one door per
  building, derived from a footprint's rings and height (no tile data), merged
  per tile and shown only at zoom 17 and above. The layout is seeded from the
  building's position, so it is stable across reloads and origin resets;
  balconies only appear on buildings with at least two floors.
- **roof** — the flat/gabled/hipped/pyramidal cap built into each building's
  mesh from its footprint, in the tile's `roof_color`. The shape is the tile's
  `roof_shape` (real `roof:shape` or an imputed one); the frontend only maps a
  shape it has no geometry for (skillion, mansard, ...) to flat. It is only
  pitched over a single, convex ring of at most `MAX_ROOF_VERTICES` (8) corners;
  a concave outline or a courtyard stays flat, since the ridge fan breaks up on
  those.
- **water** — an OSM water area (`natural=water`, `landuse=reservoir`/`basin`, a
  `water=*` value, ...) or a linear waterway (`waterway=river`/`canal`/`stream`/
  `drain`/`ditch`), emitted as `cmtype` `water` with a `water` sub-kind (`lake`,
  `river`, ...). tilegen clips it to the tile; the frontend draws areas flat and
  buffers lines into ribbons.
- **water shader** — the animated `ShaderMaterial` in `src/elements3d/water.ts`;
  the ripples are procedural (nothing is simulated), anchored to model space.
- **construction** — a clipped `landuse=construction` area with dirt, containers
  and procedural tower cranes (only on the centroid tile). Clickable.
- **crosswalk** — a marked `highway=crossing` with the road bearing and width;
  the frontend draws zebra bars along the road, repeated across it; clickable.
  The plain `crossing` point is kept only for the traffic slowdown.
- **road marking** — a stop, give-way or signal node with approach directions,
  width, lanes and turn tags; the frontend draws a stop/give-way line and lane
  arrows. It is paint, not a clickable object.
- **stop line** — the solid white bar 3.2 m before a stop/signal node; a
  give-way node gets a dashed line. It spans the approach half on a two-way
  road, the full width on a one-way one.
- **lane arrow** — one white arrow per multi-lane approach, turned by
  `turn:lanes`; a single-lane approach gets no arrow.
- **rooftop accessory** — a mapped water tower, chimney, antenna/mast or solar
  generator, lifted to the roof of the containing building. A solar polygon is
  drawn as a flat panel surface over its own footprint; solar buildings keep a
  flat roof. Clickable; shared `#rooftop-toggle`.
- **park path** — a `highway=footway|path|cycleway|bridleway` clipped to the
  tile's green union and tile bounds; `kind` is walk or bike, and the frontend
  maps `surface` to a color. `#park-paths-toggle`.
- **power tower / power line** — a `power=tower` pylon, and a `power=line` or
  `minor_line` clipped to the tile. The wire height follows the voltage, the
  tower default is 30 m; both share `#power-lines-toggle`.
- **wall / gate** — a low solid wall from a `barrier=wall`/`wall=*` way, or a
  gate node as two posts and a leaf, oriented by the nearest wall. Both share
  the `#walls-toggle`.
- **platform** — a clipped rail/tram platform area, raised by 0.28 m with a
  white edge and clickable. A platform mapped as an edge line is buffered to a
  4 m ribbon by tilegen.
- **rail** — an above-ground rail or tram way with ballast/rails/sleepers (rail)
  or embedded rails (tram), plus catenary poles and a wire. Tunnels, covered
  sections and bridge decks are skipped.
- **transit toggle** — `#transit-toggle` hides platforms, rails, stops and metro
  signs together.
- **playground** — a `leisure=playground` point with a size; the frontend draws
  sand, swings, a slide, a spring rider and a climbing frame. Clickable.
- **monument** — a `historic=monument`/`memorial` or `man_made=obelisk` point;
  `kind` and `memorial` pick a statue, bust, obelisk, war memorial, stele, plaque
  or Stolperstein. Clickable.
- **terrace** — a food/drink place with `outdoor_seating`, emitted as a point; the
  frontend draws umbrellas, tables and chairs and makes it clickable. The OSM
  amenity picks the popup label.
- **transit stop** — a metro entrance, tram stop or bus stop emitted as a point
  with `stop`, `name` and `shelter`; the frontend gives the metro its red M totem
  and the bus/tram the yellow palina plus an optional shelter. Clickable.
- **fountain** — an `amenity=fountain` point with an equivalent basin diameter;
  the frontend draws a stone basin, water disc and (for larger ones) a pedestal
  and jet. Clickable like a building, with the OSM link.
- **street furniture** — a bollard, bin, bike rack, post box, drinking
  fountain, info board or hydrant emitted as a point with a `furniture` kind;
  the frontend builds a few boxes and merges the tile into one mesh. Benches are
  separate (facing + checkbox).
- **cemetery** — a `landuse=cemetery` or `amenity=grave_yard` polygon, clipped
  to the tile and filled with procedural rows of tombstones over the basemap
  ground. The rows are laid out frontend-side from the polygon (the graves
  themselves are not mapped), so there is no per-grave tile data.
- **layer** — the OSM vertical position of water, a bridge or a tunnel, carried
  as a tile's `layer` property: `layer` when set (Seveso is `layer=-2`, a bridge
  `layer=1`), else `level` as a fallback; negative is below ground. Water below 0
  is drawn faint (`UNDERWATER_OPACITY`); a bridge's layer is its deck-height
  proxy; tilegen reports the road positions it finds.
- **bridge** — a `bridge=*` way (on a highway or railway) or a `man_made=bridge` /
  `building=bridge` footprint, emitted as `cmtype` `bridge` and clipped to the
  tile. The frontend raises a way into a slab and a footprint into a flat deck.
- **tunnel / portal** — a `tunnel=yes` road or rail way; a tunnel is underground
  and invisible, so only its **portal** (a dark frame at each true way end) is
  drawn. tilegen emits the ends as `cmtype` `tunnel` Points (never the clipped
  line, which would put a portal on every tile boundary); footway/step
  underpasses, culverts and building passages get none, and a buried waterway
  stays water.
- **imputed tag** — a building's `color` / `roof_shape` / `roof_color` when OSM
  leaves them out: `tilegen/impute.py` draws one from the observed distribution
  of that tag in the same extract, seeded from the building id. The frontend
  never imputes.
- **speed bump** — the cosmetic slowdown `src/traffic.ts` adds around a crossing:
  the renderer matches the points to a loop's vertices and turns the distance
  windows into loop-time with the local speed. The global light (**axis** 0
  roughly E-W, 1 N-S, swapping every 8 s) decides: on a red axis the vehicle
  eases down from 60 m out to ~15% of cruise and back over ~255 m, on green it
  nudges up and settles. Both bumps are smooth and return to zero, so the loop's
  path and timing are unchanged — nothing waits.
- **GTFS path** — a one-way loop built from one GTFS `shapes.txt` shape in its
  feed direction; route type 3/11 becomes a bus and type 0 a tram. Stop times
  set segment travel times and dwell. The loop metadata names the line, route
  and headsign.
- **precomputed traffic** — the route renderer (`src/traffic.ts`,
  `tilegen/traffic.py`); there is no runtime simulation.
- **car mode / drive car** — the free-driving car behind `#drive-button`.
  `DriveState` is lon/lat + heading + speed; the chase camera sits above and
  behind it and looks `DRIVE_LOOK_AHEAD` meters ahead at a fixed zoom/pitch.
  The heading keeps the vehicle bodies' convention (radians CCW from east).
  Collision is the car's rectangle against building footprints and fence/wall
  lines, not a physics simulation; the car spawns on the nearest loaded car
  route. Entering and leaving report `drive-start` / `drive-stop` perf events.
- **parking row / parked car** — a kerb line authored by tilegen with a style
  (parallel, perpendicular, fishbone), pitch, side and occupancy; clipped to the
  tile. The frontend places the occupied cars along it. The layer is static and
  gated like the facade detail; lamps are deliberately not part of this
  authoring pass.
- **street lamp / signal head** — the night light sources. Lamps are
  `[lon, lat]` in a tile's top-level `lamps` block; a signal head is a
  `traffic_signal` Point. Both are additive sprites on a thin instanced post,
  visible at night above zoom 15.
- **grade / basemap fade** — the two full-canvas DOM overlays: `#grade` is the
  warm multiply at dawn/dusk, `#basemap-fade` hides the day/night style swap
  behind a short fade to black.
- **cloud field** — the repeating sky the clouds live in; **torus** — the wrap
  that keeps sky overhead when panning; **variant / slot** — the shared cloud
  mesh shapes and their instance slots.

## Conventions

- Layer visibility toggles are checkboxes inside a layers menu in
  `index.html` (`#layer-menu-button` opens `#layer-menu-panel`,
  `#layer-menu-collapse` folds it, `#imputed-help` explains the imputed
  colors), styled in `src/map_style.css`, wired in `CoolMap`. The checkbox ids
  are `#traffic-toggle`, `#inspect-toggle`, `#clouds-toggle`, `#windows-toggle`,
  `#balconies-toggle`, `#roof-shapes-toggle`, `#water-toggle`,
  `#basemap-toggle`, `#benches-toggle`, `#churches-toggle`, `#parks-toggle`, `#airplanes-toggle`,
  `#fences-toggle`, `#bridges-toggle`, `#parked-cars-toggle`,
  `#lampposts-toggle`, `#transit-toggle`, `#sidewalks-toggle`, `#walls-toggle`,
  `#rooftop-toggle`, `#power-lines-toggle`, `#bloom-toggle`,
  `#imputed-colors-toggle`. Windows, balconies, roofs, water, benches, church
  crosses, parks, airplanes, fences, bridges & tunnels, parked cars, lamp posts
  and power lines are their own meshes, so those are plain visibility switches; the basemap checkbox swaps the MapTiler style
  for an empty style while keeping the 3D layer; imputed colors are baked into
  the geometry, so changing that one reloads the loaded tiles.
- Car mode is not a checkbox: `#drive-button` in the layers menu enters and
  leaves it, `#drive-hud` shows the speed and the keys, and Escape also leaves.
  Choosing it closes the menu. While driving, the map handlers are disabled and
  the button reports `drive-start` / `drive-stop` events through the perf
  endpoint.
- Merged per-tile geometry is disposed on unload; materials are shared
  singletons and are not disposed.
