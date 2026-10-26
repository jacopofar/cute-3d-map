# Tile generation

`tilegen/` is the offline half: it reads an OSM PBF extract and writes the JSON
tiles the frontend fetches. This page is the operational side (how to run it,
what the flags do, how to inspect the output); the tile contract itself is in
[architecture.md](architecture.md#how-it-works).

## Regenerating tiles

Put an OSM PBF extract in `data/` (e.g. from
[Geofabrik](https://download.geofabrik.de)), optionally a GeoJSON polygon to
filter the area, then from the `tilegen/` directory:

```bash
cd tilegen
uv run main.py ../data/milano_20261016.pbf \
  --polygon-filter ../data/milano_polygon.json \
  --output ../public/tiles --no-raw
```

The command above writes directly to `public/tiles/` and skips the raw-tag
tiles. Without `--output`, the render tiles go to `tilegen/tiles/` and the raw
tiles to `tilegen/raw_tiles/`; copy the render tiles into `public/tiles/` if you
use that layout. Pass `--no-raw` to skip the raw tiles.

By default the run also precomputes the vehicle routes (see
[traffic.md](traffic.md)) and writes them into the tiles; pass `--no-traffic` to
skip that step and emit only the geometry tiles. With traffic on it also writes
the loop report into `tilegen/report/` (`--report-dir` to move it, `--no-report`
to skip). Pass `--gtfs ../gtfs.zip` to use the GTFS feed for bus and tram routes;
the file is optional and currently local-only. `--city-dir ../cities/milano`
selects the city profile (it is the default when present); see *City profiles*
below.

`gtfs.zip` is ignored by git; keep it next to `pyproject.toml` and pass
`--gtfs ../gtfs.zip` from `tilegen/` when rebuilding.

To keep the PBF small up front, an `osmium extract` with the same polygon also
works. The `cmtype` list in [architecture.md](architecture.md) is a summary;
`tilegen/tiles.py` is the contract, and `tests/test_tiles.py` checks every
builder against it.

## City profiles

`tilegen` can read optional per-city overrides from a folder:

```bash
cd tilegen
uv run main.py ../data/city.pbf \
  --polygon-filter ../data/city_polygon.json \
  --city-dir ../cities/milano \
  --output ../public/tiles --no-raw
```

The folder may contain `city.json`, `buildings.json`, `areas.geojson`,
`vehicles.json` and an `assets/` directory. Building colors, roof colors/shapes
and per-building windows/balconies can be overridden by OSM id or exact name, or
by polygons in `areas.geojson`; GTFS bus/tram colors and body lengths can be
overridden by a city default, line or route id. Missing files keep the Milan
defaults. See [`cities/README.md`](../cities/README.md) for the schemas.

## Inspecting tiles

`tilegen/tile_inspector.py` renders a flat SVG or PNG of an area directly from
the generated tiles: one logical color per `cmtype`, no basemap, lighting or
3D decoration. It is the quickest way to check coverage and whether a feature
made it into the tile.

```bash
cd tilegen
uv run tile_inspector.py \
  --bbox 9.17,45.46,9.20,45.48 \
  --output /tmp/tiles.png \
  --legend
```

Use a `.svg` output for vector inspection or `.png` for a raster; PNG uses
Pillow. `--width` sets the raster width, and `--legend` adds a small color key.

## Inspecting GTFS routes

To inspect the optional feed before changing traffic logic, export its shapes:

```bash
cd tilegen
uv run gtfs_routes.py --gtfs ../gtfs.zip \
  --output ../reports/gtfs-routes.geojson \
  --summary ../reports/gtfs-routes.md
```

Each feature carries the route, line, direction counts, headsigns, length,
closed flag and `reverse_of` when another shape is its opposite direction.
When tilegen itself is run with both `--gtfs` and `--report`, it writes
`gtfs-routes.geojson` and `gtfs-routes.md` into the report directory
automatically; the standalone command above is for inspecting a feed without
rebuilding tiles.

## Lint and tests

`tilegen/` is checked by Ruff and [`ty`](https://docs.astral.sh/ty/) via
pre-commit (config at the repo root). After `uv sync --group dev` in
`tilegen/`, enable the hooks once with `uvx pre-commit install`; run them over
everything with `uvx pre-commit run --all-files`. The tilegen unit tests run with
`uv run pytest` from `tilegen/` (coverage is reported, floor 80%).

The frontend side of the toolchain is in the [README](../README.md#commands).
