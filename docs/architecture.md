# Architecture

## How it works

The project has two halves: `tilegen` to process the data and generate tiles, and
a frontend to render it, statically serving them.

1. **`tilegen/`** (Python, runs offline) — reads an OSM PBF extract, converts it
   to GeoParquet with [QuackOSM](https://github.com/InsightSoftwareConsortium/QuackOSM),
   then uses [DuckDB](https://duckdb.org) with the `spatial` extension to slice
   the data into static JSON tiles at Web-Mercator zoom 15
   (`public/tiles/{x}/{y}.json`).
   Each tile is a GeoJSON FeatureCollection with properties used for rendering:

   - `cmtype: "building"` (with `height`, `base`, `color`, `roof_shape`,
     `roof_color`):
     extruded polygon; height falls back to `building:levels * 3` or 10 m, and
     the color and roof tags are **imputed** from the dataset's own
     distribution when OSM has none (see "Imputed tags" below);
   - `cmtype: "tree"` (point) — with `type` (broadleaf/conifer) and `size`
     (crown radius, m) derived from OSM tags or a hash;
   - `cmtype: "tree_row"` (LineString) — one shared type/size for the row;
   - `cmtype: "water"` — a lake, pond or reservoir (Polygon), or a
     river/canal/stream (LineString) the frontend buffers into a ribbon. Water
     is **clipped to the tile** (a lake spans many tiles), unlike the small
     buildings, and drawn by an animated shader. The `water` property carries
     the sub-kind (`lake`, `river`, `canal`, ...) that picks its color/width;
   - `cmtype: "cemetery"` — a `landuse=cemetery` or `amenity=grave_yard`
     polygon, **clipped to the tile** like a park; the frontend fills it with
     procedural rows of tombstones;
   - `cmtype: "furniture"` (point) — a bollard, bin, bike rack, post box,
     drinking fountain, info board or hydrant. The `furniture` property picks
     the low-poly prop; the frontend merges a tile's props into one mesh;
   - `cmtype: "fountain"` (point) — an `amenity=fountain`, with an equivalent
     diameter (`size`) so a mapped basin gets a sensible circle; the frontend
     builds a stone basin, water surface and jet;
   - `cmtype: "transit_stop"` (point) — a metro entrance, tram stop or bus stop
     (`stop`), with `name` and `shelter` when OSM has them;
   - `cmtype: "terrace"` (point) — a cafe/restaurant/bar with
     `outdoor_seating`, carrying the amenity and name for the popup;
   - `cmtype: "playground"` (point) — a `leisure=playground` with a
     size (equivalent diameter) for the equipment spread;
   - `cmtype: "monument"` (point) — a `historic=monument`/`memorial` or
     `man_made=obelisk`, with the kind and `memorial` sub-kind for the look;
   - `cmtype: "construction"` — a clipped `landuse=construction` area; the tile
     holding the site centroid also carries `crane` and `site_area`;
   - `cmtype: "crosswalk"` (point) — a marked `highway=crossing`, with the road
     `bearing` and full `width` so the frontend can lay the zebra stripes;
   - `cmtype: "road_marking"` (point) — a `highway=stop`, `give_way` or
     `traffic_signals` node, with `directions`, `width`, `lanes`, `oneway` and
     `turn_lanes` for stop lines and lane arrows;
   - `cmtype: "platform"` — a clipped rail/tram platform polygon (line
     platforms are buffered to a 4 m ribbon), with a name and ref;
   - `cmtype: "park_path"` — a foot/cycle path clipped to the tile's green
     areas, with `kind` walk/bike, `surface` and `width`;
   - `cmtype: "power_tower"` (Point) — a `power=tower` pylon, with `height`;
   - `cmtype: "power_line"` (LineString) — a `power=line`/`minor_line` clipped
     to the tile, with an approximate wire `height`, `voltage`, `cables` and
     `wires`;
   - `cmtype: "rail"` (LineString/MultiLineString) — an above-ground rail or
     tram way, clipped to the tile, with `kind` rail/tram;
   - `cmtype: "traffic_signal"` / `"crossing"` (point) — an OSM
     `highway=traffic_signals` or `highway=crossing` node. The plain `crossing`
     is data-only: the frontend does not draw it, but it slows vehicles as they
     pass over it (see [traffic.md](traffic.md)) and it shows up in the debug
     GeoJSON; a marked crossing also gets the separate `crosswalk` feature.

   A tile may also carry a top-level `traffic` array (not a GeoJSON feature):
   the precomputed vehicle routes that fall inside the tile. See
   [traffic.md](traffic.md). A `parking` array holds the authored parking rows
   assigned to the tile: each has `coords` (the kerb line), `style`
   (parallel/perpendicular/fishbone), `pitch`, `side` and `occupancy`; the
   frontend places the cars along it. A `lamps` array holds the street lamps as
   `[lon, lat]`; see [layers.md](layers.md#light-and-atmosphere).

2. **`src/`** (TypeScript, Vite app) — a `CoolMap` class wraps the MapLibre map
   and adds a Three.js `CustomLayerInterface`. The map keeps its view in the URL
   as a `#map=zoom/lat/lon` permalink (MapLibre's own hash handling, with the
   `map` prefix so the fragment looks like OSM's): a position can be copied or
   linked, and a pasted link opens there. On every map move it loads/unloads
   tiles within a 3-tile margin of the center (`src/tile_loader.ts`),
   converts each feature to a Three.js object via
   `src/geojson_data.ts` and `src/elements3d/` (building, tree, tree_row,
   water, church, cemetery, furniture, fountain, transit, terrace,
   playground, monument, construction, crosswalk, road_marking, platform,
   rail, sidewalk, wall, gate).
   Coordinates are projected from EPSG:4326 → EPSG:3857 meters, centered on the
   map origin and scaled by `cos(latitude)`; the Three.js camera is driven by
   MapLibre's projection matrix. Above zoom 17 the app also builds **windows,
   balconies and one door per building** for the buildings nearest the center
   (geometry in `src/elements3d/facade.ts`, laid out by `facade_layout.ts`): it
   is derived from the footprints and heights already in the tile — no extra
   tile data — merged into one mesh per tile and rebuilt as the zoom crosses the
   gate. Every building also gets a **roof** — flat, gabled, hipped or pyramidal,
   taken from the tile's `roof_shape` (the real `roof:shape`, or imputed by the
   generator), in the tile's `roof_color`, built into the building mesh itself,
   so roofs are always there rather than zoom-gated. Footprints that are concave,
   have a courtyard, or have more than 8 corners stay flat: the ridge fan that
   builds the pitched shapes breaks up on those.
   Each building popup has a **G** button that downloads that building's walls
   and roof as a `.glb` (Three.js `GLTFExporter`).

`src/maplibre_setup.ts` fixes a MapLibre v6 issue where the web worker URL is
resolved dynamically and doesn't survive `vite build` — it wires the worker
through Vite's `?worker&url` handling.

## Imputed tags

Only a small percent of buildings carry `*colour*` tags, so the generator fills
each of those in rather than leave the tiles nearly featureless.
A missing value is **drawn from the distribution of the values that are present**
in the same extract — a dataset that is 30% red roofs yields 30% red imputed
roofs — and the draw is seeded from the building's id, so a rebuild reproduces
the same colors. The frontend never imputes: it reads `color`, `roof_shape`
and `roof_color` and maps anything it cannot draw (e.g. `roof:shape=skillion`)
to a flat roof. In the frontend it is possible to disable the imputed colors on
the fly.

## Clicking features

Every OSM-derived layer opens its popup on click, not just buildings and water:
trees and tree rows, benches, parks, cemeteries, fences and walls, gates,
bridges, tunnel portals, rails, park paths, power towers and lines, runways and
aprons, and the painted stop lines and lane arrows. A building's roof and a
church cross open the building instead. Each popup shows the name (when mapped),
a short kind label and the OSM link.

The simple layers share one `FeatureInfo` shape (a point, polylines or outer
rings) and `src/feature_pick.ts` picks the nearest one in the hit tile, so a
click on a merged per-tile mesh never needs per-feature meshes. A hidden layer is
not pickable. Sidewalks and street lamps are authored by the generator rather
than mapped as individual features, so they stay out of the popup.

## Notes and current limitations

- Data is loaded per-tile from static JSON files; there is no vector-tile or
  binary-tile path yet, and tiles carry the full GeoJSON text (large for dense
  cities like Milan — rendering works but is clunky).
- Meshes are merged per kind within a tile (one `BufferGeometry` per kind, with
  colors baked into vertex attributes), so a tile renders in a handful of draw
  calls instead of one per feature. The merged geometry is disposed when a tile
  is unloaded.
- Tile loads are debounced (150 ms); failed loads are logged and retried on a
  later move, an in-flight set avoids duplicate concurrent fetches for the same
  tile, and an HTTP 404 is treated as an empty tile (skipped tiles are not
  written).
- The projection origin is recentered when the map center drifts more than two
  tiles, which keeps the `cos(latitude)` approximation accurate. Existing
  meshes are re-expressed in the new origin's space in place (no reload), and
  tiles beyond the ±3 margin are dropped and reloaded against the new origin.
- WebXR/VR support is stubbed out (currently broken upstream, see the comment in
  `src/main.ts`).
- Three test suites: vitest for the pure math and geometry layouts
  (`src/**/*.test.ts`), about thirty Playwright specs that boot the app against
  stubbed tiles and assert by mesh kind, and a pytest suite for `tilegen/`
  (reported with coverage, floor 80%). The Playwright specs do assert geometry,
  through `__coolMap`'s read-only probes (`src/debug.ts`).
