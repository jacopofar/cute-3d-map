"""Shared parsing and geometry helpers.

Part of ``tilegen/features``: the shared parsing and geometry helpers.
"""

import math
import re
from math import atan2, cos, degrees, radians

import shapely


def parse_length(value: str | None) -> float | None:
    """Parse an OSM length value, which is a string and may carry a unit
    suffix ("12", "12.5", "12 m"). Returns None when there is no usable number."""
    if value is None:
        return None
    parts = value.strip().split()
    if not parts:
        return None
    token = parts[0].rstrip("m").strip()
    try:
        return float(token)
    except ValueError:
        return None


# the first signed number in a level value: OSM levels can be a ";" list or a
# range ("0;1", "-1--2"), and only the first matters for a single height
_LEVEL_RE = re.compile(r"-?\d+(?:\.\d+)?")


def parse_level(value) -> float | None:
    """Parse an OSM `level` value to a number (int when whole), or None when
    there is no usable number. A negative level is below ground: an underwater
    water body, or a road in a tunnel."""
    if value is None:
        return None
    match = _LEVEL_RE.search(str(value))
    if match is None:
        return None
    number = float(match.group())
    return int(number) if number.is_integer() else number


# compass letters to degrees clockwise from north, the way the frontend rotates
# a bench (0 = facing north, 90 = east). OSM also writes `direction` as plain
# degrees, so both are accepted.
COMPASS = {
    "N": 0.0,
    "NE": 45.0,
    "E": 90.0,
    "SE": 135.0,
    "S": 180.0,
    "SW": 225.0,
    "W": 270.0,
    "NW": 315.0,
}


def line_bearing(line) -> float | None:
    """The compass bearing of a line (degrees clockwise from north), for a
    bench mapped as a way: the bench runs along the line, so the line's own
    direction is the best facing the data offers. None for a degenerate line.
    Longitude is squeezed by cos(latitude) so the bearing is a real compass
    one, not a raw lon/lat angle."""
    start, end = line.coords[0], line.coords[-1]
    east = (end[0] - start[0]) * cos(radians((start[1] + end[1]) / 2))
    north = end[1] - start[1]
    if abs(east) < 1e-12 and abs(north) < 1e-12:
        return None
    return degrees(atan2(east, north)) % 360


# meters per degree of latitude; the longitude shrinks by cos(latitude)
_METERS_PER_DEGREE = 6378137.0 * math.radians(1.0)


def area_square_meters(geometry) -> float:
    """A lon/lat polygon's area in square meters, approximated locally. Fine for
    a sliver threshold, and it needs no projection."""
    latitude = geometry.centroid.y
    return (
        shapely.area(geometry)
        * _METERS_PER_DEGREE**2
        * math.cos(math.radians(latitude))
    )


def _flatten(geometry, want: str):
    """The parts of a clipped geometry of the wanted type (Polygon or
    LineString), dropping the point/sliver artifacts a boundary touch can leave
    behind. Returns a single part, a Multi of them, or None."""
    parts = []
    for part in shapely.get_parts(geometry):
        if part.is_empty:
            continue
        if part.geom_type == want:
            parts.append(part)
        elif part.geom_type == f"Multi{want}":
            parts.extend(p for p in part.geoms if not p.is_empty)
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    return (
        shapely.MultiPolygon(parts)
        if want == "Polygon"
        else shapely.MultiLineString(parts)
    )


# the road/rail class a bridge carries; the frontend turns it into a deck width
def transport_class(tags) -> str | None:
    """The highway/railway class a bridge or tunnel carries."""
    return tags.get("highway") or tags.get("railway")
