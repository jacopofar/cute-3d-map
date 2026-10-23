"""Optional GTFS source for bus and tram paths.

The OSM extract only carries the rail/tram network and the road graph; it has no
bus routes and does not know the actual tram alignments. When a GTFS zip is
passed to the generator, its `shapes.txt` becomes the source of the bus and tram
loops instead. A GTFS shape is one-directional, so it is mirrored into an
out-and-back loop; this keeps the frontend's loop/time model without inventing a
return path.

The feed's stop times are deliberately not read: the renderer needs paths and a
sensible cruise speed, not a timetable. A shape is used when its trips are route
type 3 (bus), 11 (trolleybus) or 0 (tram); metro/rail shapes are left to the OSM
rail fleet.
"""

import csv
import io
import math
import zipfile
from collections import defaultdict
from itertools import pairwise
from pathlib import Path

import shapely
from traffic import Loop, TrafficConfig, assign_vehicles, haversine_m

BUS_ROUTE_TYPES = frozenset({"3", "11"})
TRAM_ROUTE_TYPES = frozenset({"0"})
# GTFS shapes are a single line, so an out-and-back loop would put the two
# directions on top of each other. Offset each direction 1.5 m to its right;
# the return lane therefore sits 3 m from the outbound one.
LANE_OFFSET_M = 1.5

# Buses are frequent and short, trams are longer; the actual feed frequency is
# not used, so these spacing values control how many vehicles are drawn. The
# max_vehicles caps are about one third of the feed-derived fleets, which keeps
# the map readable instead of stamping every shape with a full service.
BUS_GTFS_CONFIG = TrafficConfig(
    spacing=1200.0,
    max_vehicles=1000,
    colors=("ffd23f", "f2b632", "e8e8e8"),
    gray_colors=(),
    gray_fraction=0.0,
    default_speed=8.0,
)
TRAM_GTFS_CONFIG = TrafficConfig(
    spacing=1800.0,
    max_vehicles=260,
    colors=("ff8c00", "ffd23f", "e8e8e8"),
    gray_colors=(),
    gray_fraction=0.0,
    default_speed=7.0,
)


def _rows(archive: zipfile.ZipFile, name: str):
    with archive.open(name) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        yield from csv.DictReader(text)


def _kind(route_type: str) -> str | None:
    if route_type in BUS_ROUTE_TYPES:
        return "bus"
    if route_type in TRAM_ROUTE_TYPES:
        return "tram"
    return None


def _read_routes(archive: zipfile.ZipFile) -> dict[str, dict]:
    """route_id -> the display metadata and kind for a bus/tram route."""
    routes: dict[str, dict] = {}
    for row in _rows(archive, "routes.txt"):
        kind = _kind(str(row.get("route_type", "")))
        if kind is None:
            continue
        routes[row["route_id"]] = {
            "kind": kind,
            "color": row.get("route_color") or None,
            "line": row.get("route_short_name") or None,
            "route": row.get("route_long_name") or None,
        }
    return routes


def _read_shape_info(
    archive: zipfile.ZipFile, routes: dict[str, dict]
) -> dict[str, dict]:
    """shape_id -> kinds plus the per-kind metadata shown in the vehicle popup."""
    shapes: dict[str, dict] = {}
    for row in _rows(archive, "trips.txt"):
        shape_id = row.get("shape_id")
        route = routes.get(row.get("route_id", ""))
        if not shape_id or route is None:
            continue
        entry = shapes.setdefault(
            shape_id, {"kinds": set(), "meta": {}, "color": route["color"]}
        )
        kind = route["kind"]
        entry["kinds"].add(kind)
        entry["meta"].setdefault(
            kind,
            {
                "line": route["line"] or row.get("trip_short_name") or route["route"],
                "route": route["route"],
                "headsign": row.get("trip_headsign") or None,
                "route_id": row.get("route_id") or None,
                "type": kind,
            },
        )
    return shapes


def _read_shapes(archive: zipfile.ZipFile, wanted: set[str]):
    points: dict[str, list[tuple[int, float, float]]] = defaultdict(list)
    for row in _rows(archive, "shapes.txt"):
        shape_id = row.get("shape_id")
        if shape_id not in wanted:
            continue
        try:
            sequence = int(row["shape_pt_sequence"])
            lon = float(row["shape_pt_lon"])
            lat = float(row["shape_pt_lat"])
        except (KeyError, TypeError, ValueError):
            continue
        points[shape_id].append((sequence, lon, lat))
    return {
        shape_id: [(lon, lat) for _sequence, lon, lat in sorted(items)]
        for shape_id, items in points.items()
    }


def _clean(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    result: list[tuple[float, float]] = []
    for point in points:
        if not result or haversine_m(result[-1], point) > 0.5:
            result.append(point)
    return result


def _offset_right(
    points: list[tuple[float, float]], distance: float
) -> list[tuple[float, float]]:
    """Offset a lon/lat line to the right by `distance` meters.

    Shapely works in the input coordinate units, so project locally to meters
    first: a degree of longitude is cos(latitude) shorter than a degree of
    latitude, and a raw 1.5e-5 degree offset would be visibly wrong on an
    east-west path.
    """
    if len(points) < 2:
        return []
    lat0 = sum(point[1] for point in points) / len(points)
    scale_x = 111320.0 * math.cos(math.radians(lat0))
    scale_y = 110540.0
    local = [(lon * scale_x, lat * scale_y) for lon, lat in points]
    shifted = shapely.LineString(local).offset_curve(-distance, quad_segs=8)
    parts = [
        part for part in shapely.get_parts(shifted) if part.geom_type == "LineString"
    ]
    if not parts:
        return []
    # an offset curve can split at a sharp bend; keep the longest continuous
    # piece rather than introducing a teleport in the loop
    line = max(parts, key=lambda part: part.length)
    return [(x / scale_x, y / scale_y) for x, y in line.coords]


def _round_trip(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Out and back on separate right-hand lanes.

    The outbound path is shifted right of the feed direction; the return path
    is shifted right of the reversed direction. The two short connectors at the
    termini close the loop and are what make the two lanes 3 m apart.
    """
    if len(points) < 2:
        return []
    outbound = _offset_right(points, LANE_OFFSET_M)
    returning = _offset_right(list(reversed(points)), LANE_OFFSET_M)
    if len(outbound) < 2 or len(returning) < 2:
        # degenerate geometry: keep the old plain out-and-back rather than
        # dropping a whole route
        return list(points) + list(reversed(points[:-1]))
    return outbound + returning + [outbound[0]]


def _loop(
    kind: str,
    shape_id: str,
    points: list[tuple[float, float]],
    config: TrafficConfig,
    meta: dict | None = None,
) -> Loop | None:
    coords = _round_trip(_clean(points))
    if len(coords) < 3:
        return None
    length = sum(haversine_m(a, b) for a, b in pairwise(coords))
    if length < config.min_loop_length:
        return None
    speed = config.default_speed
    return Loop(
        id=f"gtfs-{kind}-{shape_id}",
        segs=[coords],
        seg_speeds=[speed],
        length=length,
        period=length / speed,
        kind=kind,
        meta=meta,
    )


def load_gtfs_fleets(
    path: Path,
    bus_config: TrafficConfig = BUS_GTFS_CONFIG,
    tram_config: TrafficConfig = TRAM_GTFS_CONFIG,
) -> dict[str, list[Loop]]:
    """Build bus/tram loops from a GTFS zip.

    Shapes are grouped by route type and assigned vehicles with the same
    spacing logic as the OSM fleets, so the result drops straight into the
    existing per-tile traffic block.
    """
    configs = {"bus": bus_config, "tram": tram_config}
    fleets: dict[str, list[Loop]] = {"bus": [], "tram": []}
    with zipfile.ZipFile(path) as archive:
        routes = _read_routes(archive)
        shape_info = _read_shape_info(archive, routes)
        shapes = _read_shapes(archive, set(shape_info))
    for shape_id, points in shapes.items():
        info = shape_info[shape_id]
        for kind in info["kinds"]:
            loop = _loop(
                kind,
                shape_id,
                points,
                configs[kind],
                meta=info["meta"].get(kind),
            )
            if loop is not None:
                fleets[kind].append(loop)
    for kind, loops in fleets.items():
        assign_vehicles(loops, configs[kind])
        for loop in loops:
            color = shape_info[loop.id.removeprefix(f"gtfs-{kind}-")]["color"]
            if color:
                for vehicle in loop.vehicles:
                    vehicle["color"] = color
    return fleets
