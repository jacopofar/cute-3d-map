# Demo: MapLibre + Three.js + GeoJSON 3D buildings and trees

This project renders OSM-derived 3D content (extruded buildings, trees, tree rows)
on top of a MapLibre map, using Three.js as a custom layer. Unlike the original
[MapLibre 3D model example](https://maplibre.org/maplibre-gl-js/docs/examples/add-3d-model/),
the geometry is not a GLTF model: it is generated at runtime from GeoJSON tiles,
converted from EPSG:4326 to local meters and extruded into meshes.

![A map with buildings rendered in red](example.png)

## How it works

The project has two halves:

1. **`tilegen/`** (Python, run offline) — reads an OSM PBF extract, converts it
   to GeoParquet with [QuackOSM](https://github.com/InsightSoftwareConsortium/QuackOSM),
   then uses [DuckDB](https://duckdb.org) with the `spatial` extension to slice
   the data into static JSON tiles at Web-Mercator zoom 15 (`public/tiles/{x}/{y}.json`).
   Each tile is a GeoJSON FeatureCollection with properties used for rendering:
   - `cmtype: "building"` (with optional `height`, `color`) — extruded polygon,
     height falls back to `building:levels * 3` or 10 m;
   - `cmtype: "tree"` (point);
   - `cmtype: "tree_row"` (LineString);
   - `cmtype: "road"` (LineString, drivable highways only) — clipped to the
     tile and consecutive segments stitched into longer lines;
   - `cmtype: "rail"` (LineString, `railway=rail`/`tram` only, no metros) —
     clipped and stitched the same way;
   - `cmtype: "tram_stop"` (Point, `railway=tram_stop`) — the rail fleet pauses
     there in addition to crossings.

2. **`src/`** (TypeScript, Vite app) — a `CoolMap` class wraps the MapLibre map
   and adds a Three.js `CustomLayerInterface`. On every map move it loads/unloads
   tiles within a 3-tile margin of the center (`loadUnloadCoord` in
   `src/main.ts`), converts each feature to a Three.js object via
   `src/geojson_data.ts` and `src/elements3d/` (building, tree, tree_row).
   Coordinates are projected from EPSG:4326 → EPSG:3857 meters, centered on the
   map origin and scaled by `cos(latitude)`; the Three.js camera is driven by
   MapLibre's projection matrix. There is also a (commented out) GLTFExporter
   path to download the current scene as a `.glb`.

   Drivable-`highway` and `railway` features (also `cmtype: "road"`/`"rail"`)
   are not rendered; instead `src/vehicles.ts` drives fleets along them: cars
   on roads and longer, less frequent trains/trams on rails. Each fleet builds
   one graph (and closed cycles) over all loaded tiles, renders as a single
   `InstancedMesh` (per-instance color), and is only shown above a minimum
   zoom.

`src/maplibre_setup.ts` fixes a MapLibre v6 issue where the web worker URL is
resolved dynamically and doesn't survive `vite build` — it wires the worker
through Vite's `?worker&url` handling.

## Setup

Prerequisites: Node (with npm) and [uv](https://docs.astral.sh/uv/) for tilegen.

```bash
npm install

# map tiles are served from MapTiler, you need a (free) API key
echo "VITE_MAPTILER_KEY=your_key" > .env

npm run dev          # dev server
npm run build        # tsc + production build
npm run preview      # serve the production build
npm run prettify     # prettier on src/*.ts

npx playwright install   # once, for the e2e browser
npm run test:e2e         # Playwright smoke tests
```

The app expects tiles under `public/tiles/` (fetch path is `tiles/{x}/{y}.json`
relative to the app origin). A sample set covering Milan at zoom 15 is included;
regenerate them as described below for other cities.

## Regenerating tiles

Put an OSM PBF extract in `data/` (e.g. from
[Geofabrik](https://download.geofabrik.de)), optionally a GeoJSON polygon to
filter the area, then from the `tilegen/` directory:

```bash
cd tilegen
uv run main.py ../data/milano_extract.osm.pbf --polygon-filter ../data/milano_polygon.json
```

This writes render-ready tiles to `tilegen/tiles/` and, alongside, "raw" tiles
with all OSM tags to `tilegen/raw_tiles/` (useful for future renderers).
Copy/move the `tiles/` output into `public/tiles/` so the frontend can fetch it,
or write it there directly with `--output ../public/tiles` (and `--no-raw` to
skip the raw tiles).

To keep the PBF small up front, an `osmium extract` with the same polygon also
works. Features currently handled: `building`, `natural=tree`,
`natural=tree_row`; everything else is skipped.

`tilegen/` is checked by Ruff and [`ty`](https://docs.astral.sh/ty/) via
pre-commit (config at the repo root). After `uv sync --group dev` in `tilegen/`,
enable the hooks once with `uvx pre-commit install`; run them over everything
with `uvx pre-commit run --all-files`. The tilegen unit tests run with
`uv run pytest` from `tilegen/`.

## Notes and current limitations

- Data is loaded per-tile from static JSON files; there is no vector-tile or
  binary-tile path yet, and tiles carry the full GeoJSON text (large for dense
  cities like Milan — rendering works but is clunky).
- All meshes in a tile are separate objects; there is no geometry merging /
  vertex-color batching yet (see the
  [Three.js "lots of objects" manual](https://threejs.org/manual/#en/optimize-lots-of-objects)),
  so draw calls and memory scale linearly with feature count.
- Tile loads have no debounce yet; failed loads are logged and retried on the
  next map move, and an in-flight set avoids duplicate concurrent fetches for
  the same tile.
- The projection origin is recentered when the map center drifts more than two
  tiles, which keeps the `cos(latitude)` approximation accurate. Existing
  meshes are re-expressed in the new origin's space in place (no reload), and
  tiles beyond the ±3 margin are dropped and reloaded against the new origin.
- WebXR/VR support is stubbed out (currently broken upstream, see the comment in
  `src/main.ts`).
- Frontend has only Playwright smoke tests (the app boots and the tile
  pipeline responds); there are no visual/geometry assertions. `tilegen/` has a
  small pytest suite.

## Ideas / TODO

See `notes.md` for the working list. Highlights:

- merge geometries and use vertex colors to cut draw calls massively
- debounce/async-robust tile load & unload
- a server that generates tiles on demand with a backing database
  (pyosmium/quackosm + SQLite/JSON), or shortbread/vector tiles
- moving vehicles following paths
- e2e tests
