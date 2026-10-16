# AGENTS.md

Project instructions for agents working in this repo — a MapLibre + Three.js
demo that renders OSM-derived 3D buildings, trees and vehicles, plus a
decorative volumetric cloud layer.

## Language and writing

- **US English spelling** in prose, comments, identifiers and docs: `color`,
  `center`, `meter`, `gray`, `normalize`, `behavior`, `catalog`. No British
  spellings.
- **Comments are in English.** They may be expressive (surprise, annoyance,
  delight) and may sprinkle in a Yiddish / Italian / German word when it fits.
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
- `npm run test:e2e` — Playwright smoke tests (boots the app, loads tiles).
- `npm run bench` — frame-time benchmark (slow, machine-dependent; see README).
- `npm run prettify` — Prettier over `src/**.ts`. It also reformats unrelated
  lines, so prefer formatting only the files you touched.

Run `tsc` and `npm run test:e2e` before reporting a frontend change as done.

## Architecture

- `src/main.ts` — `CoolMap` wraps the MapLibre map and adds the Three.js
  `CustomLayerInterface`. Loads/unloads tiles within a 3-tile margin of the
  center (`loadUnloadCoord`), debounced 150 ms.
- `src/geojson_data.ts` — fetches `tiles/{x}/{y}.json`, converts features to
  Three.js geometry via `src/elements3d/`, and merges one `BufferGeometry` per
  kind per tile (vertex colors, so a tile is a handful of draw calls).
- `src/traffic.ts` — `TrafficRenderer`: stateless renderer of the precomputed
  routes; the only fleet renderer.
- `src/clouds.ts` — decorative volumetric cloud layer (disabled above a zoom).
- `tilegen/` — Python (uv, ruff, ty) offline tile generator; output lands in
  `public/tiles/{x}/{y}.json`.
- `tilegen/geo.py` — slippy-tile helpers shared by the generator.
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
  `tree_row` (the road/rail network is not emitted; routes come from
  `traffic`).
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
- **precomputed traffic** — the route renderer (`src/traffic.ts`,
  `tilegen/traffic.py`); there is no runtime simulation.
- **cloud field** — the repeating sky the clouds live in; **torus** — the wrap
  that keeps sky overhead when panning; **variant / slot** — the shared cloud
  mesh shapes and their instance slots.

## Conventions

- Layer visibility toggles are checkboxes in `index.html`
  (`#traffic-toggle`, `#inspect-toggle`, `#clouds-toggle`), styled in
  `src/map_style.css`, wired in `CoolMap`.
- Merged per-tile geometry is disposed on unload; materials are shared
  singletons and are not disposed.
