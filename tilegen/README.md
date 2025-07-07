# tilegen
This is the component that can read a PBF file and generate the data tiles for the 3D visualization.

Usage:

    uv run main.py data.pbf --polygon-filter polygon.json

`--polygon-filter` expects a GeoJSON polygon to be used as a filter.
If missing the whole data in the PBF file is used