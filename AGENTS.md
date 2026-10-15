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
- `src/vehicles.ts` — car and train fleets driven along road / rail paths.
- `src/clouds.ts` — decorative volumetric cloud layer (disabled above a zoom).
- `tilegen/` — Python (uv, ruff, ty) offline tile generator; output lands in
  `public/tiles/{x}/{y}.json`.

## Domain lexicon

- **tile** — a `public/tiles/{x}/{y}.json` file at `TILE_ZOOM` (15).
- **tile key** — the `x_y` string used in `loadedTiles` / `pendingTiles`.
- **origin** — the projection origin (`tileCenter`) in EPSG:3857; model
  coordinates are meters relative to it, scaled by `cos(latitude)`.
- **origin reset** — recentering the origin when the view drifts more than 2
  tiles from it.
- **render margin** — how many tiles beyond the center tile stay loaded (3).
- **cmtype** — the per-feature kind tag in a tile: `building`, `tree`,
  `tree_row`, `road`, `rail`, `tram_stop`.
- **fleet** — a `VehicleManager` (cars on roads, trains on rails).
- **cloud field** — the repeating sky the clouds live in; **torus** — the wrap
  that keeps sky overhead when panning; **variant / slot** — the shared cloud
  mesh shapes and their instance slots.

## Conventions

- Layer visibility toggles are checkboxes in `index.html`
  (`#traffic-toggle`, `#inspect-toggle`, `#clouds-toggle`), styled in
  `src/map_style.css`, wired in `CoolMap`.
- Merged per-tile geometry is disposed on unload; materials are shared
  singletons and are not disposed.
