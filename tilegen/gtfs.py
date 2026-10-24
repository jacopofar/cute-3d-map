"""Optional GTFS source for bus and tram paths.

The OSM extract only carries the rail/tram network and the road graph; it has no
bus routes and does not know the actual tram alignments. When a GTFS zip is
passed to the generator, its `shapes.txt` becomes the source of the bus and tram
loops instead. A GTFS shape is one-directional, so it is used as a one-way
loop in the feed's direction; vehicles pop at the end and reappear at the start.
Stop times supply the travel time between stops and a short dwell at each one.

Shapes are used in the direction the feed provides; there is no synthetic
return trip. When `stop_times.txt` is available, each stop-to-stop segment uses
the GTFS travel time and dwell. A shape is used when its trips are route type 3
(bus), 11 (trolleybus) or 0 (tram); metro/rail shapes are left to the OSM rail
fleet.
"""

import csv
import io
import zipfile
from collections import Counter, defaultdict
from itertools import pairwise
from pathlib import Path

import shapely
from city import CityProfile
from shapely.geometry import Point
from shapely.ops import substring
from traffic import Loop, TrafficConfig, assign_vehicles, haversine_m

BUS_ROUTE_TYPES = frozenset({"3", "11"})
TRAM_ROUTE_TYPES = frozenset({"0"})
# GTFS often has arrival == departure at a stop; still make the vehicle pause
# there so the stop is visible rather than a continuous fly-through.
MIN_STOP_DWELL = 12.0
# GTFS travel times are scaled up for the map: a 50% faster vehicle makes the
# service readable at city scale while keeping the scheduled stop dwell.
GTFS_SPEED_FACTOR = 1.5
# Buses are frequent and short, trams are longer; the actual feed frequency is
# not used, so these spacing values control how many vehicles are drawn. The
# max_vehicles caps are about one third of the feed-derived fleets, which keeps
# the map readable instead of stamping every shape with a full service.
BUS_GTFS_CONFIG = TrafficConfig(
    spacing=1200.0,
    max_vehicles=1500,
    colors=("ffd23f", "f2b632", "e8e8e8"),
    gray_colors=(),
    gray_fraction=0.0,
    default_speed=8.0,
)
TRAM_GTFS_CONFIG = TrafficConfig(
    spacing=1800.0,
    max_vehicles=390,
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


def _loop(
    kind: str,
    shape_id: str,
    points: list[tuple[float, float]],
    config: TrafficConfig,
    meta: dict | None = None,
) -> Loop | None:
    """One-way fallback loop for a shape with no usable stop times."""
    coords = _clean(points)
    if len(coords) < 2:
        return None
    length = sum(haversine_m(a, b) for a, b in pairwise(coords))
    if length < config.min_loop_length:
        return None
    speed = config.default_speed * GTFS_SPEED_FACTOR
    return Loop(
        id=f"gtfs-{kind}-{shape_id}",
        segs=[coords],
        seg_speeds=[speed],
        length=length,
        period=length / speed,
        kind=kind,
        meta=meta,
    )


def _parse_time(value: str | None) -> float | None:
    """Parse a GTFS HH:MM:SS time, including hours past 24, to seconds."""
    if not value:
        return None
    try:
        hours, minutes, seconds = (int(part) for part in value.split(":"))
    except (TypeError, ValueError):
        return None
    return hours * 3600 + minutes * 60 + seconds


def _read_stops(archive: zipfile.ZipFile) -> dict[str, tuple[float, float]]:
    if "stops.txt" not in archive.namelist():
        return {}
    stops: dict[str, tuple[float, float]] = {}
    for row in _rows(archive, "stops.txt"):
        try:
            stops[row["stop_id"]] = (float(row["stop_lon"]), float(row["stop_lat"]))
        except (KeyError, TypeError, ValueError):
            continue
    return stops


def _read_stop_times(
    archive: zipfile.ZipFile, trip_ids: set[str]
) -> dict[str, list[dict]]:
    if "stop_times.txt" not in archive.namelist():
        return {}
    times: dict[str, list[dict]] = defaultdict(list)
    for row in _rows(archive, "stop_times.txt"):
        trip_id = row.get("trip_id")
        if trip_id not in trip_ids:
            continue
        try:
            sequence = int(row["stop_sequence"])
        except (KeyError, TypeError, ValueError):
            continue
        times[trip_id].append(
            {
                "sequence": sequence,
                "stop_id": row.get("stop_id"),
                "arrival": _parse_time(row.get("arrival_time")),
                "departure": _parse_time(row.get("departure_time")),
            }
        )
    return dict(times)


def _scheduled_loop(
    kind: str,
    shape: dict,
    stop_times: list[dict],
    stops: dict[str, tuple[float, float]],
    config: TrafficConfig,
) -> Loop | None:
    """Build a one-way loop with GTFS travel times and stop dwells."""
    points = _clean(shape["coords"])
    if len(points) < 2 or len(stop_times) < 2:
        return None
    line = shapely.LineString(points)
    scheduled: list[tuple[float, float, float]] = []
    for row in sorted(stop_times, key=lambda item: item["sequence"]):
        stop = stops.get(row.get("stop_id"))
        if stop is None:
            continue
        distance = line.project(Point(stop))
        arrival = row.get("arrival")
        departure = row.get("departure")
        if arrival is None or departure is None:
            continue
        scheduled.append((distance, arrival, departure))
    if len(scheduled) < 2:
        return None
    if any(a[0] >= b[0] for a, b in pairwise(scheduled)):
        return None

    segs: list[list[tuple[float, float]]] = []
    times: list[float] = []
    dwells: list[float] = []
    lengths: list[float] = []
    for current, following in pairwise(scheduled):
        start, arrival, departure = current
        next_distance, next_arrival, next_departure = following
        segment = substring(line, start, next_distance, normalized=False)
        coords = [(lon, lat) for lon, lat in segment.coords]
        if len(coords) < 2:
            return None
        travel = max(1.0, (next_arrival - departure) / GTFS_SPEED_FACTOR)
        dwell = max(MIN_STOP_DWELL, next_departure - next_arrival)
        segs.append(coords)
        times.append(travel)
        dwells.append(dwell)
        lengths.append(sum(haversine_m(a, b) for a, b in pairwise(coords)))
    length = sum(lengths)
    period = sum(times) + sum(dwells)
    if length < config.min_loop_length or period <= 0:
        return None
    return Loop(
        id=f"gtfs-{kind}-{shape['shape_id']}",
        segs=segs,
        seg_speeds=[
            lengths[i] / times[i] if times[i] else 0.0 for i in range(len(segs))
        ],
        length=length,
        period=period,
        seg_times=times,
        seg_dwells=dwells,
        kind=kind,
        meta=shape["meta"],
    )


def read_route_shapes(path: Path) -> list[dict]:
    """Route shapes with their trips and direction metadata, for inspection.

    Only bus/tram routes are returned; metro shapes are intentionally outside
    the traffic layer this feed drives.
    """
    with zipfile.ZipFile(path) as archive:
        routes = _read_routes(archive)
        shape_info = _read_shape_info(archive, routes)
        shapes = _read_shapes(archive, set(shape_info))
        trips: dict[str, list[dict]] = defaultdict(list)
        for row in _rows(archive, "trips.txt"):
            shape_id = row.get("shape_id")
            if shape_id in shapes:
                trips[shape_id].append(row)
    result: list[dict] = []
    for shape_id, points in shapes.items():
        info = shape_info[shape_id]
        kind = next(iter(info["kinds"]))
        meta = info["meta"][kind]
        directions = Counter(row.get("direction_id") or "" for row in trips[shape_id])
        first_trip = trips[shape_id][0] if trips[shape_id] else {}
        result.append(
            {
                "shape_id": shape_id,
                "trip_id": first_trip.get("trip_id"),
                "kind": kind,
                "route_id": meta.get("route_id"),
                "line": meta.get("line"),
                "route": meta.get("route"),
                "route_type": meta.get("type"),
                "meta": meta,
                "color": info.get("color"),
                "trip_count": len(trips[shape_id]),
                "directions": dict(directions),
                "headsigns": sorted(
                    {
                        row.get("trip_headsign") or ""
                        for row in trips[shape_id]
                        if row.get("trip_headsign")
                    }
                ),
                "coords": points,
                "length_m": round(
                    sum(haversine_m(a, b) for a, b in pairwise(points)), 1
                ),
                "closed": bool(
                    len(points) > 1 and haversine_m(points[0], points[-1]) < 30
                ),
            }
        )
    return result


def load_gtfs_fleets(
    path: Path,
    bus_config: TrafficConfig = BUS_GTFS_CONFIG,
    tram_config: TrafficConfig = TRAM_GTFS_CONFIG,
    city: CityProfile | None = None,
) -> dict[str, list[Loop]]:
    """Build one-way bus/tram loops from a GTFS zip.

    A shape is used in the direction GTFS provides; there is no mirrored return
    trip. When stop_times are present, each stop-to-stop segment carries its
    GTFS travel time and the vehicle dwells there for the scheduled pause.
    """
    configs = {"bus": bus_config, "tram": tram_config}
    fleets: dict[str, list[Loop]] = {"bus": [], "tram": []}
    shapes = read_route_shapes(path)
    trip_ids = {shape["trip_id"] for shape in shapes if shape.get("trip_id")}
    with zipfile.ZipFile(path) as archive:
        stops = _read_stops(archive)
        stop_times = _read_stop_times(archive, trip_ids)
    for shape in shapes:
        kind = shape["kind"]
        loop = _scheduled_loop(
            kind,
            shape,
            stop_times.get(shape.get("trip_id"), []),
            stops,
            configs[kind],
        )
        if loop is None:
            loop = _loop(
                kind,
                shape["shape_id"],
                shape["coords"],
                configs[kind],
                shape.get("meta"),
            )
        if loop is not None:
            fleets[kind].append(loop)
    colors = {shape["shape_id"]: shape.get("color") for shape in shapes}
    for kind, loops in fleets.items():
        assign_vehicles(loops, configs[kind])
        for loop in loops:
            shape_id = loop.id.removeprefix(f"gtfs-{kind}-")
            color = city.vehicle_color(loop.meta) if city else None
            color = color or colors.get(shape_id)
            if color:
                for vehicle in loop.vehicles:
                    vehicle["color"] = color
    return fleets
