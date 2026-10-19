"""Place static parked cars along the sides of the road network.

Parking is dense and purely decorative: both sides of every parking-eligible way
are filled at a pitch set by the parking style (parallel, perpendicular or
fishbone), and about 95% of the bays are taken. The result is plain data — a
lon/lat and a model-space heading per car — grouped by tile. The frontend draws
them with the moving cars' body, statically.

Short ways (the connectors that stitch the network together) and roundabouts are
skipped: they are not streets anyone parks along, and filling them would only add
cars in intersections and on traffic islands.

The ways are read from the parquet in `main.load_parking_ways`; this module is
pure (plain `ParkingWay` inputs) so it is unit-tested like `traffic.py`.
"""

import math
from collections import defaultdict
from dataclasses import dataclass
from itertools import pairwise

from geo import TILE_ZOOM, coord_to_tile

# The parked cars use the moving cars' body; keep these in sync with
# CAR_TRAFFIC in src/traffic.ts.
CAR_LENGTH = 8 / 3
CAR_WIDTH = 4 / 3

# roads worth parking along: no motorways/trunks, and no `*_link` ramps (the
# connectors the request says to ignore)
PARKING_HIGHWAYS = frozenset(
    {
        "primary",
        "secondary",
        "tertiary",
        "unclassified",
        "residential",
        "living_street",
        "service",
        "road",
    }
)

# a way shorter than this is a connector/stub, not a street worth filling
MIN_WAY_LENGTH = 30.0

# approximate half carriageway width per class, in meters: the parked car sits
# just beyond it, so the bay does not spill into the driving lanes
ROAD_HALF_WIDTH = {
    "primary": 5.5,
    "secondary": 4.5,
    "tertiary": 3.5,
    "unclassified": 3.0,
    "residential": 3.0,
    "living_street": 2.5,
    "service": 2.5,
    "road": 3.0,
}
DEFAULT_HALF_WIDTH = 3.0

PARALLEL = "parallel"
PERPENDICULAR = "perpendicular"
FISHBONE = "fishbone"

# percent of bays that hold a car; the rest are empty slots
OCCUPANCY = 95

METERS_PER_DEG_LAT = 110540.0
METERS_PER_DEG_LON = 111320.0


@dataclass
class ParkingWay:
    """A parking-eligible highway, with the tags the placement needs."""

    id: str
    coords: list[tuple[float, float]]
    highway: str
    roundabout: bool = False


def _hash(text: str) -> int:
    """FNV-1a, so a way's placement is stable across rebuilds and processes
    (Python's `hash` is salted and would reshuffle the cars every run)."""
    value = 2166136261
    for byte in text.encode():
        value ^= byte
        value = (value * 16777619) & 0xFFFFFFFF
    return value


def _mix(seed: int, k: int) -> int:
    value = (seed ^ (k * 0x85EBCA6B) ^ 0x9E3779B9) & 0xFFFFFFFF
    value ^= value >> 13
    value = (value * 0xC2B2AE35) & 0xFFFFFFFF
    value ^= value >> 16
    return value


def _segment(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    """The segment's displacement in meters (east, north)."""
    cos_lat = math.cos(math.radians((a[1] + b[1]) / 2))
    return (
        (b[0] - a[0]) * METERS_PER_DEG_LON * cos_lat,
        (b[1] - a[1]) * METERS_PER_DEG_LAT,
    )


def way_length(coords: list[tuple[float, float]]) -> float:
    return sum(math.hypot(*_segment(a, b)) for a, b in pairwise(coords))


def parking_style(seed: int, highway: str) -> str:
    """The bay layout for a way, seeded from its id. Narrow/local streets are
    mostly parallel; wider roads get more perpendicular and fishbone bays."""
    roll = seed % 100
    if highway in {"residential", "living_street", "service", "unclassified", "road"}:
        if roll < 72:
            return PARALLEL
        return PERPENDICULAR if roll < 90 else FISHBONE
    if roll < 28:
        return PARALLEL
    return PERPENDICULAR if roll < 62 else FISHBONE


def bay_pitch(style: str) -> float:
    """Distance between neighbouring bays along the kerb, in meters."""
    if style == PARALLEL:
        return CAR_LENGTH + 1.4
    if style == PERPENDICULAR:
        return CAR_WIDTH + 0.7
    # the along-road footprint of a 45-degree car, plus a gap
    return (CAR_LENGTH + CAR_WIDTH) * math.sin(math.pi / 4) + 0.7


def walk_way(
    coords: list[tuple[float, float]], pitch: float
) -> list[tuple[float, float, float]]:
    """Points at `pitch` meter intervals along the polyline, as
    (lon, lat, heading). Starts half a pitch in and stops half a pitch short, so
    bays do not sit on the junctions at either end."""
    segments = []
    total = 0.0
    for a, b in pairwise(coords):
        east, north = _segment(a, b)
        length = math.hypot(east, north)
        if length < 1e-6:
            continue
        segments.append((a, b, length, east / length, north / length, total))
        total += length
    if not segments or total <= pitch:
        return []
    spots = []
    distance = pitch / 2
    index = 0
    while distance < total - pitch / 2:
        while (
            index < len(segments) - 1
            and segments[index][5] + segments[index][2] < distance
        ):
            index += 1
        a, b, length, east, north, start = segments[index]
        fraction = (distance - start) / length
        spots.append(
            (
                a[0] + (b[0] - a[0]) * fraction,
                a[1] + (b[1] - a[1]) * fraction,
                math.atan2(north, east),
            )
        )
        distance += pitch
    return spots


def _car_at(
    lon: float,
    lat: float,
    road_heading: float,
    side: int,
    style: str,
    highway: str,
) -> tuple[float, float, float]:
    """The car's position and heading for one bay. `side` is +1 for the left of
    the way and -1 for the right; the car sits just beyond the carriageway and
    faces the direction a car parked there would."""
    half_road = ROAD_HALF_WIDTH.get(highway, DEFAULT_HALF_WIDTH)
    if style == PARALLEL:
        offset = half_road + CAR_WIDTH / 2 + 0.25
        heading = road_heading + (math.pi if side > 0 else 0.0)
    elif style == PERPENDICULAR:
        offset = half_road + CAR_LENGTH / 2 + 0.25
        heading = road_heading + side * math.pi / 2
    else:
        # a 45-degree herringbone bay; the car's extent normal to the road is
        # the projection of its length and width
        offset = (
            half_road
            + (CAR_LENGTH / 2) * math.sin(math.pi / 4)
            + (CAR_WIDTH / 2) * math.cos(math.pi / 4)
            + 0.25
        )
        heading = road_heading + side * (math.pi / 2 - math.pi / 4)
    # outward normal for this side, in meters
    normal_east = -math.sin(road_heading) * side
    normal_north = math.cos(road_heading) * side
    cos_lat = math.cos(math.radians(lat))
    return (
        lon + normal_east * offset / (METERS_PER_DEG_LON * cos_lat),
        lat + normal_north * offset / METERS_PER_DEG_LAT,
        heading,
    )


def parking_spots(
    ways: list[ParkingWay], zoom: int = TILE_ZOOM
) -> dict[tuple[int, int], list[list[float]]]:
    """All parked cars, grouped by the tile they fall in. Each spot is
    [lon, lat, heading]; a car belongs to exactly one tile, so tiles need no
    clipping or dedupe."""
    by_tile: dict[tuple[int, int], list[list[float]]] = defaultdict(list)
    for way in ways:
        if way.roundabout or way.highway not in PARKING_HIGHWAYS:
            continue
        if way_length(way.coords) < MIN_WAY_LENGTH:
            continue
        seed = _hash(way.id)
        style = parking_style(seed, way.highway)
        pitch = bay_pitch(style)
        for side in (1, -1):
            for index, (lon, lat, heading) in enumerate(walk_way(way.coords, pitch)):
                # 95% of the bays hold a car; 5% are empty, seeded per bay
                if _mix(seed ^ (side & 0xFFFFFFFF), index) % 100 >= OCCUPANCY:
                    continue
                car_lon, car_lat, car_heading = _car_at(
                    lon, lat, heading, side, style, way.highway
                )
                tile = coord_to_tile(car_lon, car_lat, zoom)
                by_tile[tile].append(
                    [round(car_lon, 7), round(car_lat, 7), round(car_heading, 4)]
                )
    return dict(by_tile)
