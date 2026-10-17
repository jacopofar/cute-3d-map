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
- `npx tsc --noEmit` / `npm run build` — type check / production build.
- `npm run test:unit` — vitest for the pure traffic math (`src/traffic_math.ts`),
  with coverage.
- `npm run test:e2e` — Playwright smoke tests (boots the app, loads tiles).
- `npm run bench` — frame-time benchmark (slow, machine-dependent; see README).
- `npm run prettify` — Prettier over `src/**.ts`. It also reformats unrelated
  lines, so prefer formatting only the files you touched.

Run `tsc`, `npm run test:unit` and `npm run test:e2e` before reporting a
frontend change as done. `uv run pytest` in `tilegen/` reports coverage
(`--cov`, floor 80%).

## Architecture

- `src/main.ts` — `CoolMap` wraps the MapLibre map and adds the Three.js
  `CustomLayerInterface`. Loads/unloads tiles within a 3-tile margin of the
  center (`loadUnloadCoord`), debounced 150 ms.
- `src/geojson_data.ts` — fetches `tiles/{x}/{y}.json`, converts features to
  Three.js geometry via `src/elements3d/`, and merges one `BufferGeometry` per
  kind per tile (vertex colors, so a tile is a handful of draw calls).
- `src/elements3d/facade_layout.ts` / `facade.ts` — procedural window, balcony
  and door detail. The layout is pure maths (seeded, unit-tested); `facade.ts`
  turns it into one merged geometry per tile (quads wound to match their normal,
  since OSM rings come in both windings). `CoolMap` builds it only above zoom 17
  and only for the tiles around the center (`loadedDetail`), and drops it when
  zoomed out or when the origin resets.
- `src/elements3d/roof_layout.ts` / `roof.ts` — the roof over each footprint,
  drawn as its own mesh per tile (kind `roof`) so the roof-shapes checkbox is a
  visibility switch. The shape comes from the tile's `roof_shape`; the layout is
  pure maths and unit-tested. Footprints with an inner ring, a concave outline,
  or more than `MAX_ROOF_VERTICES` (8) corners stay flat, as the ridge fan breaks
  up on them. `src/elements3d/random.ts` holds the seeded PRNG and hash shared by
  the facade and roof code.
- `src/traffic.ts` — `TrafficRenderer`: stateless renderer of the precomputed
  routes; the only fleet renderer.
- `src/clouds.ts` — decorative volumetric cloud layer (disabled above a zoom).
- `tilegen/` — Python (uv, ruff, ty) offline tile generator; output lands in
  `public/tiles/{x}/{y}.json`.
- `tilegen/geo.py` — slippy-tile helpers shared by the generator.
- `tilegen/impute.py` — fills a building's missing color/roof tags by sampling
  the distribution of the values that ARE present (seeded per building, so a
  rebuild reproduces the tiles). Pure: it takes counts and tag mappings, so it
  is unit-tested like `traffic.py`.
- `tilegen/traffic.py` — precomputes vehicle routes: global graph, loop
  generation (`random` three-point loops for cars, planar `faces` for trains),
  per-tile split. Per-fleet configs (`CAR_CONFIG`, `TRAIN_CONFIG`) drive cars
  and trains, and `loop_report` / `loops_to_geojson` build the loop report.
  Takes plain `Way` inputs and does no OSM I/O itself (`main.load_ways` reads
  the parquet), so it is dependency-free and unit-tested in `tilegen/tests/`.

## Domain lexicon

- **tile** — a `public/tiles/{x}/{y}.json` file at `TILE_ZOOM` (15).
- **tile key** — the `x_y` string used in `loadedTiles` / `pendingTiles`.
- **origin** — the projection origin (`tileCenter`) in EPSG:3857; model
  coordinates are meters relative to it, scaled by `cos(latitude)`.
- **origin reset** — recentering the origin when the view drifts more than 2
  tiles from it.
- **render margin** — how many tiles beyond the center tile stay loaded (3).
- **cmtype** — the per-feature kind tag in a tile: `building`, `tree`,
  `tree_row`, `traffic_signal`, `crossing` (the road/rail network is not
  emitted; routes come from `traffic`).
- **fleet** — a `TrafficRenderer`; everything the traffic block holds.
- **loop** — a closed walk of the road (or rail) graph; the unit of precomputed
  traffic.
- **method** — how a fleet builds loops: `random` (cars: shortest paths through
  three random nodes) or `faces` (trains: planar faces of the graph).
- **kind** — a loop/vehicle tag, `car` or `train`; picks the fleet and body.
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
- **precomputed traffic** — the route renderer (`src/traffic.ts`,
  `tilegen/traffic.py`); there is no runtime simulation.
- **cloud field** — the repeating sky the clouds live in; **torus** — the wrap
  that keeps sky overhead when panning; **variant / slot** — the shared cloud
  mesh shapes and their instance slots.

## Conventions

- Layer visibility toggles are checkboxes inside a layers menu in
  `index.html` (`#layer-menu-button` opens `#layer-menu-panel`,
  `#layer-menu-collapse` folds it, `#imputed-help` explains the imputed
  colors), styled in `src/map_style.css`, wired in `CoolMap`. The checkbox ids
  are unchanged (`#traffic-toggle`, `#inspect-toggle`, `#clouds-toggle`,
  `#windows-toggle`, `#balconies-toggle`, `#roof-shapes-toggle`,
  `#imputed-colors-toggle`). Windows, balconies and roofs are their own meshes,
  so those are plain visibility switches; imputed colors are baked into the
  geometry, so changing that one reloads the loaded tiles.
- Merged per-tile geometry is disposed on unload; materials are shared
  singletons and are not disposed.
