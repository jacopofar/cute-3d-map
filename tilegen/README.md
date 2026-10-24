# tilegen
This is the component that can read a PBF file and generate the data tiles for the 3D visualization.

Usage:

```bash
uv run main.py data.pbf \
  --polygon-filter polygon.json \
  --city-dir ../cities/milano \
  --output ../public/tiles --no-raw
```

`--polygon-filter` expects a GeoJSON polygon to be used as a filter; if missing,
the whole PBF is used. `--city-dir` loads optional building/vehicle overrides
from `cities/<name>/` and defaults to `cities/milano` when present; see
`cities/README.md`. `--output` defaults to `tiles/`, and `--raw` is on by
default unless you pass `--no-raw`.

If `--gtfs` is supplied and the report is enabled, the report directory also
gets `gtfs-routes.geojson` and `gtfs-routes.md` for inspecting the feed's
directional and already-paired shapes. GTFS shapes are used one-way in the feed
direction; `stop_times.txt` supplies travel times and stop dwell.

## Traffic loop cache

Building the vehicle loops is one of the slowest steps (tens of minutes for a
city-sized extract: the random car generator runs thousands of A* searches over
the whole road graph). The result is cached under `cache/`, keyed by a hash of
the ways and the traffic configs, so a rerun on the same extract reuses the
loops instead of recomputing them. Pass `--no-cache` to force a rebuild, or
`--cache-dir` to move the cache.
