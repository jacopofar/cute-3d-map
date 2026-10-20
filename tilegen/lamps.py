"""Street lamps along the roads, for the night glow.

Decorative points, one row on each side of every parking-eligible road, at a
fixed pitch just beyond the kerb. The frontend draws them as additive warm
sprites on a thin post; they are what makes the night scene read as a city
rather than a grid of lit windows.

The ways are the same `ParkingWay` inputs the parked cars use; the lamp module
is pure so it is unit-tested like `parking.py`.
"""

import math
from collections import defaultdict

from geo import TILE_ZOOM, coord_to_tile
from parking import (
    DEFAULT_HALF_WIDTH,
    METERS_PER_DEG_LAT,
    METERS_PER_DEG_LON,
    MIN_WAY_LENGTH,
    PARKING_HIGHWAYS,
    ROAD_HALF_WIDTH,
    ParkingWay,
    walk_way,
    way_length,
)

# metres between lamps on one side of the road
LAMP_SPACING = 55.0
# the pole sits just beyond the kerb, on the sidewalk
LAMP_OFFSET = 0.9


def lamp_spots(
    ways: list[ParkingWay], zoom: int = TILE_ZOOM
) -> dict[tuple[int, int], list[list[float]]]:
    """All street lamps, grouped by tile. Each is [lon, lat] (the heading does
    not matter: the post is symmetric and the glow is a billboard)."""
    by_tile: dict[tuple[int, int], list[list[float]]] = defaultdict(list)
    for way in ways:
        if way.roundabout or way.highway not in PARKING_HIGHWAYS:
            continue
        if way_length(way.coords) < MIN_WAY_LENGTH:
            continue
        offset = ROAD_HALF_WIDTH.get(way.highway, DEFAULT_HALF_WIDTH) + LAMP_OFFSET
        for side in (1, -1):
            for lon, lat, heading in walk_way(way.coords, LAMP_SPACING):
                # outward normal for this side, in metres
                east = -math.sin(heading) * side
                north = math.cos(heading) * side
                cos_lat = math.cos(math.radians(lat))
                lamp_lon = lon + east * offset / (METERS_PER_DEG_LON * cos_lat)
                lamp_lat = lat + north * offset / METERS_PER_DEG_LAT
                by_tile[coord_to_tile(lamp_lon, lamp_lat, zoom)].append(
                    [round(lamp_lon, 7), round(lamp_lat, 7)]
                )
    return dict(by_tile)
