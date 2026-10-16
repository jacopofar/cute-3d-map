"""Shared slippy-tile / WGS84 helpers for the tile generator."""

import math

# Web-Mercator zoom at which tiles are generated and served. Must match
# TILE_ZOOM in src/geojson_data.ts, since the frontend requests
# tiles/{x}/{y}.json at that zoom.
TILE_ZOOM = 15


def coord_to_tile(lon: float, lat: float, zoom: float) -> tuple[int, int]:
    """From EPSG:4326 to web-mercator tile indices.

    See https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames
    """
    return (
        int((lon + 180) / 360 * (2**zoom)),
        int(
            (
                1
                - math.log(
                    math.tan(lat * math.pi / 180) + 1 / math.cos(lat * math.pi / 180)
                )
                / math.pi
            )
            / 2
            * (2**zoom)
        ),
    )


def tile_lonlat_bounds(x: int, y: int, zoom: int) -> tuple[float, float, float, float]:
    """(min_lon, min_lat, max_lon, max_lat) of a slippy tile in EPSG:4326."""
    n = 2**zoom
    min_lon = x / n * 360 - 180
    max_lon = (x + 1) / n * 360 - 180
    max_lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    min_lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return min_lon, min_lat, max_lon, max_lat
