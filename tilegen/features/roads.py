"""Road data, crossings, signals and painted markings.

Part of ``tilegen/features``: the road data, crossings, signals and painted markings.
"""

import json
import logging
import math
import re
from dataclasses import dataclass
from math import atan2, cos, degrees, radians

import shapely
from shapely.geometry import LineString, Point

from .common import parse_length

logger = logging.getLogger(__name__)


def to_stop_point(feature_id, tags, s, cmtype: str) -> dict | None:
    """A signal or crossing as a Point feature. Data-only for the frontend (the
    vehicles that yield to it are gated from the precomputed traffic block); it
    exists so the tiles and the debug GeoJSON can show where the yields are."""
    if s.geom_type != "Point":
        logger.warning(f"non-point {cmtype}?? {feature_id} ({s.geom_type})")
        return None
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {"cmtype": cmtype},
    }


def to_traffic_signal(feature_id, tags, s) -> dict | None:
    """Build the data-only signal point."""
    return to_stop_point(feature_id, tags, s, "traffic_signal")


def to_crossing(feature_id, tags, s) -> dict | None:
    """Build the data-only crossing point."""
    return to_stop_point(feature_id, tags, s, "crossing")


@dataclass(frozen=True)
class RoadData:
    """The road under a crossing or a stop node: its local bearing, width and
    lane tags, used by the zebra and the stop-line/arrow markings."""

    bearing: float
    width: float
    lanes: int = 1
    oneway: str | None = None
    turn_lanes: str | None = None
    turn_lanes_backward: str | None = None


# full carriageway width by highway class, used when OSM gives neither width
# nor lanes. Deliberately generous: a short zebra under a wide road is worse
# than a stripe that reaches a little onto the kerb.
ROAD_WIDTHS = {
    "motorway": 14.0,
    "motorway_link": 9.0,
    "trunk": 14.0,
    "trunk_link": 9.0,
    "primary": 12.0,
    "primary_link": 8.0,
    "secondary": 10.0,
    "secondary_link": 7.0,
    "tertiary": 9.0,
    "tertiary_link": 6.5,
    "unclassified": 7.0,
    "residential": 7.0,
    "living_street": 6.0,
    "service": 5.0,
    "road": 7.0,
}

ROAD_PRIORITY = {name: rank for rank, name in enumerate(ROAD_WIDTHS)}


def road_width(tags) -> float:
    """Estimate the full road width from `width`, then `lanes`, then the class."""
    width = parse_length(tags.get("width"))
    if width:
        return min(max(width, 3.0), 20.0)
    lanes = tags.get("lanes")
    if lanes:
        match = re.search(r"\d+", str(lanes))
        if match:
            return min(max(3.25 * int(match.group()) + 1.0, 3.5), 20.0)
    return ROAD_WIDTHS.get(tags.get("highway"), 7.0)


def way_bearing(line: LineString, point: Point) -> float:
    """Compass bearing (degrees clockwise from north) of the line at the point.

    Use the segment that contains the projected point, not a 2 m chord across it:
    a crossing often sits on a way vertex, and the chord across a bend gives a
    diagonal bisector instead of either street's direction.
    """
    distance = line.project(point)
    coords = list(line.coords)
    # The frontend rotates in model space, where x is scaled by cos(latitude).
    # A raw lon/lat atan2 skews every diagonal road; project the segment first.
    scale = cos(radians(point.y))
    travelled = 0.0
    for index in range(len(coords) - 1):
        start, end = coords[index], coords[index + 1]
        length = math.hypot(end[0] - start[0], end[1] - start[1])
        if distance <= travelled + length + 1e-12:
            return (
                degrees(
                    atan2(
                        (end[0] - start[0]) * scale,
                        end[1] - start[1],
                    )
                )
                % 360
            )
        travelled += length
    return 0.0


def crossing_is_marked(tags) -> bool:
    """Whether a crossing node should get zebra stripes. OSM's marking tags are
    inconsistent: `crossing:markings` wins when present, while a bare
    `highway=crossing` is usually marked in Italy."""
    crossing = (tags.get("crossing") or "").strip().lower()
    if crossing in ("unmarked", "informal", "no"):
        return False
    markings = (tags.get("crossing:markings") or "").strip().lower()
    if markings:
        return "zebra" in markings or markings == "yes"
    return True


def parse_lane_count(tags, width: float) -> int:
    """Infer a lane count from tags or the road width."""
    value = tags.get("lanes")
    if value:
        match = re.search(r"\d+", str(value))
        if match:
            return min(max(int(match.group()), 1), 8)
    return min(max(round(width / 3.25), 1), 8)


def approach_bearings(tags, road: RoadData) -> list[float]:
    """Which traffic directions stop at this node. `direction=forward/backward`
    is relative to the matched way and is common on Italian stop/give-way nodes;
    signals get both approaches unless the road is one-way."""
    oneway = (road.oneway or "").lower()
    direction = (tags.get("direction") or "").strip().lower()
    if direction == "forward":
        return [road.bearing]
    if direction == "backward":
        return [(road.bearing + 180.0) % 360]
    if direction:
        try:
            return [float(direction) % 360]
        except ValueError:
            pass
    if oneway in ("yes", "true", "1"):
        return [road.bearing]
    if oneway == "-1":
        return [(road.bearing + 180.0) % 360]
    if tags.get("highway") == "traffic_signals":
        return [road.bearing, (road.bearing + 180.0) % 360]
    # A bare stop/give-way node has no direction; one approach is less wrong
    # than painting the line on both sides of the road.
    return [road.bearing]


def to_road_marking(
    feature_id, tags, s, road_data: dict[int, RoadData] | None
) -> dict | None:
    """Stop lines and lane arrows for a stop, give-way or signal node."""
    if s.geom_type != "Point":
        return None
    kind = {
        "stop": "stop",
        "give_way": "give_way",
        "traffic_signals": "signal",
    }.get(tags.get("highway"))
    road = (road_data or {}).get(feature_id)
    if kind is None or road is None:
        return None
    directions = approach_bearings(tags, road)
    properties = {
        "cmtype": "road_marking",
        "kind": kind,
        "directions": [round(value, 1) for value in directions],
        "width": round(road.width, 1),
        "lanes": road.lanes,
        "oneway": road.oneway,
        "turn_lanes": road.turn_lanes,
        "turn_lanes_backward": road.turn_lanes_backward,
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def to_crosswalk(
    feature_id, tags, s, road_data: dict[int, RoadData] | None
) -> dict | None:
    """A marked crossing as its own Point, with the road bearing and width.
    The plain `crossing` Point stays data-only for the traffic slowdown."""
    if s.geom_type != "Point" or not crossing_is_marked(tags):
        return None
    road = (road_data or {}).get(feature_id)
    if road is None:
        return None
    properties = {
        "cmtype": "crosswalk",
        "bearing": round(road.bearing, 1),
        "width": round(road.width, 1),
        "crossing": tags.get("crossing"),
        "markings": tags.get("crossing:markings"),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }
