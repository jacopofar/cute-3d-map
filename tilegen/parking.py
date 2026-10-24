"""Place static parked cars along the sides of the road network.

Parking is dense and purely decorative: both sides of every parking-eligible way
are filled at a pitch set by the parking style (parallel, perpendicular or
fishbone), and about 95% of the bays are taken. The result is plain data — a
lon/lat and a model-space heading per car — grouped by tile. The frontend draws
them with the moving cars' body, statically.

Short ways (the connectors that stitch the network together) and roundabouts are
skipped: they are not streets anyone parks along, and filling them would only add
cars in intersections and on traffic islands. Different ways that share a kerb
(a service way beside a road, the two carriageways of a dual carriageway) are
deduped, keeping the bigger road's car, so two styles never occupy one spot.

The ways are read from the parquet in `main.load_parking_ways`; this module is
pure (plain `ParkingWay` inputs) so it is unit-tested like `traffic.py`.
"""

import math
from collections import defaultdict
from dataclasses import dataclass
from itertools import pairwise

import shapely
from shapely.ops import substring

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

# Two different ways can share a kerb (a service way beside a secondary road, or
# the two carriageways of a dual carriageway): their bays would overlap and
# z-fight. Keep one car when two bays land this close (the higher road class
# wins). Adjacent perpendicular bays are ~2.03 m apart, so this threshold does
# not eat legitimate neighbours.
MIN_SPOT_SPACING = 2.0

# A parking row stops short of a junction: if its end is this close to another
# car road (and that road crosses it rather than running alongside), trim this
# many meters from the row. Only car roads are checked; pedestrian areas keep
# their Italian parking anarchy.
JUNCTION_DISTANCE = 8.0
JUNCTION_TRIM = 8.0
JUNCTION_MIN_LENGTH = 12.0

# which way wins when two ways overlap: the bigger road keeps its parking
HIGHWAY_RANK = {
    "primary": 0,
    "secondary": 1,
    "tertiary": 2,
    "road": 3,
    "unclassified": 4,
    "residential": 5,
    "living_street": 6,
    "service": 7,
}

METERS_PER_DEG_LAT = 110540.0
METERS_PER_DEG_LON = 111320.0


@dataclass
class ParkingWay:
    """A parking-eligible highway, with the tags the placement needs."""

    id: str
    coords: list[tuple[float, float]]
    highway: str
    roundabout: bool = False
    # sidewalk generation reads these; parking ignores them
    sidewalk_left: bool = True
    sidewalk_right: bool = True
    sidewalk_width_left: float = 2.0
    sidewalk_width_right: float = 2.0
    # full OSM road width where it can be estimated; sidewalks sit outside this
    width: float | None = None


@dataclass(frozen=True)
class ParkingRow:
    """A kerb-side parking lane, authored by tilegen and filled by the frontend.

    `coords` is the line the car centres sit on; `side` keeps the orientation
    (left/right of the way) so the renderer can turn perpendicular and fishbone
    cars. The tile carries only these rows, never the individual car positions.
    """

    id: str
    coords: list[tuple[float, float]]
    style: str
    pitch: float
    side: int
    occupancy: int = OCCUPANCY


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


def sidewalk_side(tags, side: str) -> bool:
    """Whether a road carries a generated sidewalk on `left` or `right`.
    `separate` means the footway is mapped on its own, so we leave it alone."""
    value = str(tags.get(f"sidewalk:{side}") or tags.get("sidewalk") or "").lower()
    if value in ("no", "none", "separate"):
        return False
    if value in ("left", "right"):
        return value == side
    return True


def parking_offset(style: str, highway: str) -> float:
    """Distance from the road centreline to the car centre for this style."""
    half_road = ROAD_HALF_WIDTH.get(highway, DEFAULT_HALF_WIDTH)
    if style == PARALLEL:
        return half_road + CAR_WIDTH / 2 + 0.25
    if style == PERPENDICULAR:
        return half_road + CAR_LENGTH / 2 + 0.25
    # a 45-degree herringbone bay; the car's extent normal to the road is the
    # projection of its length and width
    return (
        half_road
        + (CAR_LENGTH / 2) * math.sin(math.pi / 4)
        + (CAR_WIDTH / 2) * math.cos(math.pi / 4)
        + 0.25
    )


def parking_heading(road_heading: float, side: int, style: str) -> float:
    if style == PARALLEL:
        return road_heading + (math.pi if side > 0 else 0.0)
    if style == PERPENDICULAR:
        return road_heading + side * math.pi / 2
    return road_heading + side * (math.pi / 2 - math.pi / 4)


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
    offset = parking_offset(style, highway)
    heading = parking_heading(road_heading, side, style)
    # outward normal for this side, in meters
    normal_east = -math.sin(road_heading) * side
    normal_north = math.cos(road_heading) * side
    cos_lat = math.cos(math.radians(lat))
    return (
        lon + normal_east * offset / (METERS_PER_DEG_LON * cos_lat),
        lat + normal_north * offset / METERS_PER_DEG_LAT,
        heading,
    )


def offset_polyline(
    coords: list[tuple[float, float]], offset: float, side: int
) -> list[tuple[float, float]]:
    """Offset a lon/lat polyline to one side by `offset` meters.

    Each vertex uses the average of its adjacent segment normals, so a corner
    gets one miter point instead of a double vertex. The result is the line the
    car centres will be placed on, not another copy of the road.
    """
    if len(coords) < 2:
        return []
    segments: list[tuple[tuple[float, float], tuple[float, float], float, float]] = []
    for a, b in pairwise(coords):
        east, north = _segment(a, b)
        length = math.hypot(east, north)
        if length < 1e-6:
            continue
        segments.append((a, b, east / length, north / length))
    if not segments:
        return []
    out: list[tuple[float, float]] = []
    for index, point in enumerate(coords):
        normals: list[tuple[float, float]] = []
        if index > 0 and index <= len(segments):
            _, _, east, north = segments[index - 1]
            normals.append((-north * side, east * side))
        if index < len(segments):
            _, _, east, north = segments[index]
            normals.append((-north * side, east * side))
        if not normals:
            continue
        east = sum(normal[0] for normal in normals)
        north = sum(normal[1] for normal in normals)
        length = math.hypot(east, north)
        if length < 1e-9:
            continue
        cos_lat = math.cos(math.radians(point[1]))
        out.append(
            (
                point[0] + (east / length) * offset / (METERS_PER_DEG_LON * cos_lat),
                point[1] + (north / length) * offset / METERS_PER_DEG_LAT,
            )
        )
    return out


def _way_at(
    way: ParkingWay, point: tuple[float, float]
) -> tuple[float, tuple[float, float]]:
    """Distance (m) and direction of the nearest segment of a way."""
    best_distance = math.inf
    best_direction = (1.0, 0.0)
    for a, b in pairwise(way.coords):
        east, north = _segment(a, b)
        length = math.hypot(east, north)
        if length < 1e-9:
            continue
        px, py = _segment(a, point)
        t = max(0.0, min(1.0, (px * east + py * north) / (length * length)))
        distance = math.hypot(px - east * t, py - north * t)
        if distance < best_distance:
            best_distance = distance
            best_direction = (east / length, north / length)
    return best_distance, best_direction


def _nearest_other_road(
    point: tuple[float, float],
    way_id: str,
    ways: list[ParkingWay],
    tree: shapely.STRtree,
) -> float:
    delta = 0.00012
    candidates = tree.query(
        shapely.box(
            point[0] - delta,
            point[1] - delta,
            point[0] + delta,
            point[1] + delta,
        )
    )
    nearest = math.inf
    for index in candidates:
        way = ways[index]
        if way.id == way_id:
            continue
        distance, _direction = _way_at(way, point)
        nearest = min(nearest, distance)
    return nearest


def _crossing_intervals(
    line: shapely.LineString,
    coords: list[tuple[float, float]],
    way_id: str,
    ways: list[ParkingWay],
    tree: shapely.STRtree,
    clearance: float,
    endpoint_distance: float,
    total: float,
) -> list[tuple[float, float]]:
    """Intervals of a row to remove around crossing roads and near its ends."""
    intervals: list[tuple[float, float]] = []
    for index in tree.query(line):
        way = ways[index]
        if way.id == way_id:
            continue
        other = shapely.LineString(way.coords)
        if not line.intersects(other):
            continue
        intersection = line.intersection(other)
        for part in shapely.get_parts(intersection):
            if part.is_empty:
                continue
            if part.geom_type == "Point":
                distance = line.project(part) / line.length * total
                intervals.append(
                    (
                        max(0.0, distance - clearance),
                        min(total, distance + clearance),
                    )
                )
            elif part.geom_type in ("LineString", "MultiLineString"):
                for segment in shapely.get_parts(part):
                    if segment.geom_type != "LineString" or segment.is_empty:
                        continue
                    start = (
                        line.project(shapely.Point(segment.coords[0]))
                        / line.length
                        * total
                    )
                    end = (
                        line.project(shapely.Point(segment.coords[-1]))
                        / line.length
                        * total
                    )
                    low, high = sorted((start, end))
                    intervals.append(
                        (
                            max(0.0, low - clearance),
                            min(total, high + clearance),
                        )
                    )
    if _nearest_other_road(coords[0], way_id, ways, tree) <= endpoint_distance:
        intervals.append((0.0, min(total, clearance)))
    if _nearest_other_road(coords[-1], way_id, ways, tree) <= endpoint_distance:
        intervals.append((max(0.0, total - clearance), total))
    return intervals


def _merge_intervals(
    intervals: list[tuple[float, float]], total: float
) -> list[tuple[float, float]]:
    """Merge overlapping removal windows, with a sentinel at the row end."""
    if not intervals:
        return []
    intervals = sorted(intervals)
    merged: list[tuple[float, float]] = []
    for start, end in intervals:
        if not merged or start > merged[-1][1]:
            merged.append((start, end))
        else:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
    return merged + [(total, total)]


def clear_pieces(
    line: shapely.LineString,
    coords: list[tuple[float, float]],
    way_id: str,
    ways: list[ParkingWay],
    tree: shapely.STRtree,
    pitch: float,
    clearance: float = JUNCTION_TRIM,
    endpoint_distance: float = JUNCTION_DISTANCE,
    min_length: float | None = None,
) -> list[list[tuple[float, float]]]:
    """Split a parking row around every crossing road and trim its ends.

    A row can cross a road in the middle even when neither endpoint is near one;
    those crossings used to leave cars parked across the junction. Subtract an
    8 m window around every intersection (and endpoint), then keep only pieces
    long enough to hold at least one bay.
    """
    total = way_length(coords)
    if total <= 0:
        return []
    intervals = _crossing_intervals(
        line,
        coords,
        way_id,
        ways,
        tree,
        clearance,
        endpoint_distance,
        total,
    )
    if not intervals:
        return [coords]
    minimum = max(4.0, pitch) if min_length is None else min_length
    pieces: list[list[tuple[float, float]]] = []
    cursor = 0.0
    for start, end in _merge_intervals(intervals, total):
        if start - cursor >= minimum:
            piece = substring(
                line,
                cursor / total,
                start / total,
                normalized=True,
            )
            if piece.geom_type == "LineString" and not piece.is_empty:
                pieces.append([(lon, lat) for lon, lat in piece.coords])
        cursor = max(cursor, end)
    return pieces


def parking_rows(ways: list[ParkingWay]) -> list[ParkingRow]:
    """Author kerb-side parking as rows, in priority order and deduped.

    A row is one side of one way at the style's car-centre offset. Overlapping
    rows (a service way beside a main road, dual carriageways) are dropped when
    most of their sample bays land on an already-kept row; the frontend then
    only has to walk the rows, not reproduce the road overlap logic.
    """
    rows: list[ParkingRow] = []
    tree = shapely.STRtree([shapely.LineString(way.coords) for way in ways])
    ordered = sorted(
        ways,
        key=lambda way: (HIGHWAY_RANK.get(way.highway, len(HIGHWAY_RANK)), way.id),
    )
    cell = MIN_SPOT_SPACING
    reference_lat = sum(lat for way in ordered for _, lat in way.coords) / max(
        1, sum(len(way.coords) for way in ordered)
    )
    cos_ref = math.cos(math.radians(reference_lat))
    grid: dict[tuple[int, int], list[tuple[float, float]]] = defaultdict(list)

    for way in ordered:
        if way.roundabout or way.highway not in PARKING_HIGHWAYS:
            continue
        if way_length(way.coords) < MIN_WAY_LENGTH:
            continue
        seed = _hash(way.id)
        style = parking_style(seed, way.highway)
        pitch = bay_pitch(style)
        offset = parking_offset(style, way.highway)
        for side in (1, -1):
            coords = offset_polyline(way.coords, offset, side)
            if len(coords) < 2:
                continue
            pieces = clear_pieces(
                shapely.LineString(coords), coords, way.id, ways, tree, pitch
            )
            for piece in pieces:
                samples = [(lon, lat) for lon, lat, _ in walk_way(piece, pitch)]
                clashes = 0
                for lon, lat in samples:
                    x = lon * METERS_PER_DEG_LON * cos_ref
                    y = lat * METERS_PER_DEG_LAT
                    cx = math.floor(x / cell)
                    cy = math.floor(y / cell)
                    for ix in (cx - 1, cx, cx + 1):
                        for iy in (cy - 1, cy, cy + 1):
                            if any(
                                math.hypot(x - ox, y - oy) < MIN_SPOT_SPACING
                                for ox, oy in grid[(ix, iy)]
                            ):
                                clashes += 1
                                break
                        else:
                            continue
                        break
                if samples and clashes / len(samples) > 0.5:
                    continue
                for lon, lat in samples:
                    x = lon * METERS_PER_DEG_LON * cos_ref
                    y = lat * METERS_PER_DEG_LAT
                    grid[(math.floor(x / cell), math.floor(y / cell))].append((x, y))
                rows.append(
                    ParkingRow(
                        id=f"{way.id}:{'+' if side > 0 else '-'}",
                        coords=piece,
                        style=style,
                        pitch=pitch,
                        side=side,
                    )
                )
    return rows


def _dedupe(
    spots: list[tuple[float, float, float]],
) -> list[tuple[float, float, float]]:
    """Drop cars that sit on top of an already-kept car.

    Overlapping OSM ways (a service way along a secondary road, the two
    carriageways of a dual carriageway) produce bays at nearly the same place,
    often with different styles; two intersecting car boxes read as overlapping
    cars and z-fight. The input order is by road class, so the bigger road's car
    is the one kept. A spatial hash at the spacing size makes this linear.
    """
    if not spots:
        return []
    cell = MIN_SPOT_SPACING
    grid: dict[tuple[int, int], list[tuple[float, float]]] = defaultdict(list)
    kept: list[tuple[float, float, float]] = []
    # one reference latitude for every point, so distances are consistent; using
    # each point's own cos would overstate the separation between neighbours
    reference_lat = sum(lat for _, lat, _ in spots) / len(spots)
    cos_ref = math.cos(math.radians(reference_lat))
    for lon, lat, heading in spots:
        x = lon * METERS_PER_DEG_LON * cos_ref
        y = lat * METERS_PER_DEG_LAT
        cx = math.floor(x / cell)
        cy = math.floor(y / cell)
        clash = False
        for ix in (cx - 1, cx, cx + 1):
            for iy in (cy - 1, cy, cy + 1):
                for ox, oy in grid[(ix, iy)]:
                    if math.hypot(x - ox, y - oy) < MIN_SPOT_SPACING:
                        clash = True
                        break
                if clash:
                    break
            if clash:
                break
        if clash:
            continue
        grid[(cx, cy)].append((x, y))
        kept.append((lon, lat, heading))
    return kept


def parking_spots(
    ways: list[ParkingWay], zoom: int = TILE_ZOOM
) -> dict[tuple[int, int], list[list[float]]]:
    """All parked cars, grouped by the tile they fall in. Each spot is
    [lon, lat, heading]; a car belongs to exactly one tile, so tiles need no
    clipping. Overlapping ways are deduped first, with the bigger road winning."""
    raw: list[tuple[float, float, float]] = []
    # deterministic order, and the bigger road keeps its parking on an overlap
    ordered = sorted(
        ways,
        key=lambda way: (HIGHWAY_RANK.get(way.highway, len(HIGHWAY_RANK)), way.id),
    )
    for way in ordered:
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
                raw.append(_car_at(lon, lat, heading, side, style, way.highway))

    by_tile: dict[tuple[int, int], list[list[float]]] = defaultdict(list)
    for car_lon, car_lat, car_heading in _dedupe(raw):
        tile = coord_to_tile(car_lon, car_lat, zoom)
        by_tile[tile].append(
            [round(car_lon, 7), round(car_lat, 7), round(car_heading, 4)]
        )
    return dict(by_tile)
