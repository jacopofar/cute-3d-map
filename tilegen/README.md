# tilegen
This is the component that can read a PBF file and generate the data tiles for the 3D visualization.

Usage:

    uv run main.py data.pbf --polygon-filter polygon.json

`--polygon-filter` expects a GeoJSON polygon to be used as a filter.
If missing the whole data in the PBF file is used

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
