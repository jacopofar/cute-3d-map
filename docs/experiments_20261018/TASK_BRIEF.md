# Shared brief: adding a feature to the threejs_map demo

Read this first, then the task-specific section in your prompt. You are one of
several agents each adding ONE feature on its own branch. Do not touch other
features' work. Keep your change focused.

## Repo

Working dir: `/home/jacopo/projects/threejs_map` (a git repo, branch `main`).
It is a MapLibre + Three.js demo: OSM-derived buildings/trees/water on a
MapLibre map, Three.js as a `CustomLayerInterface`. Python `tilegen/` produces
static JSON tiles offline; `src/` is the Vite/TypeScript app.

Read `AGENTS.md` and `README.md` for the full architecture and the lexicon.
`src/main.ts` (`CoolMap`) is the hub: it loads tiles, owns the toggles, and
renders. `src/geojson_data.ts` turns a tile's GeoJSON features into Three.js
geometry. Pure helpers live in `src/elements3d/`.

## The data path (memorize this)

1. `tilegen/main.py` reads the Milano parquet and writes
   `public/tiles/{x}/{y}.json` (one GeoJSON FeatureCollection per tile).
   Each render feature carries a `cmtype` property (`building`, `tree`,
   `tree_row`, `water`, `traffic_signal`, `crossing`). A tile may also carry a
   top-level `traffic` array (precomputed vehicle routes).
2. `src/geojson_data.ts`:
   - `geoJSONtoGeometries(feature, originMeters, scaleFactor, imputedColors)`
     dispatches on `cmtype` to a builder in `src/elements3d/` and returns
     `{ kind, geometries }[]`.
   - `objectsAt(...)` merges all geometries of one `kind` per tile into a single
     `BufferGeometry` (`BufferGeometryUtils.mergeGeometries`) and picks one
     shared material for that kind. The merged mesh gets
     `userData = { kind, tileKey }`.
3. `src/main.ts` adds those meshes to the scene, keeps them per tile, and shows
   toggles.

### Adding a new kind (the common case)

- Add a builder module `src/elements3d/<kind>.ts` exporting a function that
  returns `THREE.BufferGeometry[]`, built in model meters (use
  `toModelCoords` from `../geojson_data`), with colors baked as a vertex-color
  attribute (`applyVertexColor` from `./vertex_color`).
- Add the `cmtype` case in `geoJSONtoGeometries`.
- Add the `kind` to the return-type unions and to the material selection in
  `objectsAt` (the nested ternary near `const material = ...`). Create the
  material as a module-level singleton.
- Wire a checkbox (see below).
- **Every geometry of a given `kind` must have the same attribute set** or
  `mergeGeometries` returns null and the tile is dropped. The existing sets:
  `building`/`roof`/`tree` = position, normal, uv, color; `water` = position,
  color + custom attrs (non-indexed). Either match one of those or delete the
  unused attributes (`geometry.deleteAttribute("normal")`, etc.) so the whole
  kind agrees.

### Adding a checkbox

- `index.html`: add
  `<label id="<name>-toggle"><input type="checkbox" checked /> <label text></label>`
  inside `#layer-menu-panel` (next to the existing ones).
- `src/main.ts`: in the constructor, wire it with the existing `wireToggle`
  helper: `wireToggle("#<name>-toggle", (on) => { this.<flag>Enabled = on;
  this.applyTileVisibility(); });` if the layer is its own per-tile mesh (the
  usual case — a plain visibility switch). If it is baked into the building
  geometry instead, follow the `imputed-colors-toggle` pattern (reload tiles).
- Add the flag to the class and apply it wherever visibility is applied
  (`applyTileVisibility`, `applyRoofVisibility`, `applyWaterVisibility`, or a
  new `applyXVisibility`). Also apply it in `syncBuildingDetail` /
  after tile load, as the existing code does.
- The checkbox must work on already-loaded meshes without a reload if possible.

### Zoom gating (optional)

Small detail that is sub-pixel when zoomed out (facade windows, benches,
fences) may be gated like `FACADE_MIN_ZOOM` (built only above a zoom, only for
the center tiles). The pattern lives in `syncBuildingDetail`. If unsure, an
always-loaded mesh with a visibility toggle is simpler and acceptable; say so in
your report.

## Tilegen

`tilegen/main.py` — the `elif` chain in `tile_to_geojson` decides what is
emitted; add a `to_<kind>(feature_id, tags, s)` function returning a GeoJSON
feature dict (see `to_tree`, `to_water` for the shape). For geometry that spans
tiles (areas, long lines) clip to the tile like `to_water` does (it gets
`tile_box`). Units/levels: `parse_length`, `parse_level`, `vertical_level`.

Regenerate the tiles after a tilegen change (takes ~60 s; the parquet and the
traffic loops are cached):

```bash
cd /home/jacopo/projects/threejs_map/tilegen
uv run main.py ../data/milano_20261016.pbf --polygon-filter ../data/milano_polygon.json --output ../public/tiles --no-raw
```

`public/tiles/` is gitignored, so the tiles are NOT part of your commit — say in
your report that the user must regenerate them (the command above). `data/` is
also gitignored.

## Commands

Run from the repo root:

```bash
npx tsc --noEmit          # type check (must pass)
npm run build             # optional, production build
npm run test:unit         # vitest + coverage (must pass)
npm run test:e2e          # Playwright smoke tests (must pass)
npm run bench             # frame-time benchmark (~1.5 min; compare to baseline)
```

A dev server may already be running on http://localhost:5173 (reused by the
Playwright configs and by the screenshot helper). Leave it running.

### Visual checking (do this!)

Take a screenshot and LOOK at it (use the `read` tool on the PNG — it renders
the image to you). Helper:

```bash
cd /home/jacopo/projects/threejs_map
node /tmp/opencode/shot.mjs /tmp/opencode/<name>.png "18/45.4641/9.1919" 9000
# args: out.png, "zoom/lat/lon", waitMs
# Use USE_MOCK_STYLE=1 to hide the basemap (blank background, 3D still renders)
```

Milan POIs (lat/lon for zoom 18):
- Duomo cathedral: 45.4641 / 9.1919
- Linate airport: 45.4444 / 9.2706
- Parco Sempione / Castello: 45.4720 / 9.1770
- Cimitero Monumentale: 45.4860 / 9.1790

Pick a place where your feature is visible. A good screenshot shows the
feature clearly; if you cannot find one, move the map and retry. Attributes on
the scene you can dump in the page for debugging:
`window.__coolMap.customLayer.scene` and `window.__coolMap.stats()`
(only set in dev builds).

You can also write a throwaway script under `/tmp/opencode/` to poke
`__coolMap` (e.g. read your new meshes' bounding boxes, count them). Do not
commit scripts under `/tmp`.

### Benchmark baseline (main, this machine)

```
startup: 49 tiles, 178 meshes, 456869 drawn triangles, 25 draw calls
idle p50 165.4 ms / p90 184.6 ; pan p50 146.6 / p90 181.4 (SwiftShader)
byKind: tree 1.28M tris, building 0.69M, roof 0.037M, water 0.002M
```

This box is shared and noisy; only compare like-with-like and do not chase
small deltas. Report the numbers; note if your feature adds a lot of geometry.

## Conventions (from AGENTS.md)

- US English spelling everywhere (`color`, `center`, `meter`). OSM tag keys
  keep their spelling (`building:colour`, `roof:colour`).
- Comments in English, explain WHY (tradeoff / rejected alternative / perf),
  not what. No emoji.
- Commit: imperative, single-line subject in sentence case, no `feat:`/`fix:`
  prefix. Add a body only when the why is not obvious. Keep unrelated
  reformatting out. Format only the files you touched
  (`npx prettier --write <files>`), never the whole tree.

## git

Work on your own branch off `main`:

```bash
cd /home/jacopo/projects/threejs_map
git checkout main && git checkout -b <branch-name>
```

`git add` only the files you created/edited (never `git add -A`, never commit
`public/tiles`, `data/`, `perf-results/`, or `/tmp` scripts). Commit your work
on the branch. Do NOT merge to main, do NOT push.

## Definition of done (report against these)

1. `npx tsc --noEmit` clean; `npm run test:unit` and `npm run test:e2e` pass;
   `npm run bench` run (numbers reported).
2. A new e2e assertion covers your feature (mesh count/toggle) — see
   `e2e/layers.spec.ts`. Add a vitest unit test if you have pure math.
3. A checkbox in the layers menu toggles the feature.
4. A screenshot exists at a path you report and the feature is clearly visible.
5. Tiles regenerated and the command noted.
6. One commit on the branch; report hash + branch.
7. Time-box: aim to reach a committed state within ~45 minutes. Prefer a
   working simple version over a half-finished clever one. If something does
   not work, commit what does and say exactly what is missing / what decision
   you need from the user.

## Report format (your final message)

- branch + commit hash
- what works (and the screenshot path)
- what is missing / needs a user decision
- tests: tsc / unit / e2e / bench numbers
- files changed
