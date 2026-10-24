"""Pure OSM-tag predicates and tile feature builders.

Everything in this module turns one OSM feature (tags + shapely geometry) into a
render-ready tile feature. It has no parquet or DuckDB I/O; the loaders and the
tile pipeline live in ``main.py``. Keeping these builders separate makes them
easy to unit-test and keeps the orchestration file focused.
"""

import json
import logging
import math
import re
import zlib
from dataclasses import dataclass
from math import atan2, cos, degrees, radians

import shapely
from shapely.geometry import LineString, Point

from city import BuildingOverride
from impute import impute

logger = logging.getLogger(__name__)


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


GLASS_MATERIAL_TAGS = ("building:material", "building:facade:material")


def is_glass(tags) -> bool:
    """Whether the facade is tagged as glass/mirror. The values are free text and
    may be `;` lists (`plaster;glass`), so look for the words rather than compare
    the whole string."""
    for tag in GLASS_MATERIAL_TAGS:
        value = str(tags.get(tag, "")).lower()
        if "glass" in value or "mirror" in value:
            return True
    return False


def vertical_level(tags) -> float | None:
    """A feature's OSM vertical position: `layer` when it is set (the tunnel /
    bridge ordering: Seveso is `layer=-2`, a bridge is `layer=1`), else `level`.
    Negative means below ground."""
    return parse_level(tags.get("layer") or tags.get("level"))


def building_base(tags) -> float:
    """The bottom of a building volume: `min_height`, else `min_level` * 3 m.
    Building parts often start above the street (a tower on a podium)."""
    base = parse_length(tags.get("min_height"))
    if base is None:
        level = parse_level(tags.get("min_level") or tags.get("building:min_level"))
        if level is not None:
            base = level * 3
    return max(0.0, base or 0.0)


def building_top(tags, base: float) -> float | None:
    """The top of a building volume. `height` is the top elevation when present;
    otherwise `max_level` is the top, or the level count is added to the base."""
    height = parse_length(tags.get("height"))
    if height is None:
        max_level = parse_level(tags.get("max_level"))
        if max_level is not None:
            height = max_level * 3
        elif "building:levels" in tags:
            levels = parse_length(tags["building:levels"])
            if levels is not None:
                height = base + levels * 3
    if height is not None and height <= base:
        return base + 0.5
    if height is None and base > 0:
        # a part with a base but no height should still have a sensible volume
        return base + 10.0
    return height


POWER_LINE_KINDS = frozenset({"line", "minor_line"})


def is_power_line(tags) -> bool:
    """An overhead power line. Underground sections and cable tunnels are not
    drawn: they have no pylon silhouette in the 3D view."""
    return (
        tags.get("power") in POWER_LINE_KINDS
        and tags.get("location") != "underground"
        and tags.get("tunnel") not in ("yes", "building_passage")
    )


def power_wire_height(tags) -> float:
    """Approximate wire height from voltage, since OSM rarely tags line height.
    The tower default is 25 m; these keep the spans near the crossarms."""
    voltage = parse_length(tags.get("voltage"))
    if voltage is None:
        return 20.0
    if voltage >= 380_000:
        return 26.0
    if voltage >= 220_000:
        return 23.0
    if voltage >= 132_000:
        return 19.0
    return 16.0


def to_power_tower(feature_id, tags, s) -> dict | None:
    """Build a power-tower point feature."""
    if s.geom_type != "Point":
        return None
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {
            "cmtype": "power_tower",
            "height": parse_length(tags.get("height")) or 30.0,
            "name": tags.get("name"),
            "operator": tags.get("operator"),
            "ref": tags.get("ref"),
        },
    }


def to_power_line(feature_id, tags, s, tile_box) -> list[dict]:
    """Clip one overhead line to the tile; the frontend draws the catenary."""
    if not is_power_line(tags) or s.geom_type not in ("LineString", "MultiLineString"):
        return []
    clipped = s.intersection(tile_box)
    features: list[dict] = []
    for part in shapely.get_parts(clipped):
        if part.geom_type != "LineString" or part.length < 1e-5:
            continue
        properties = {
            "cmtype": "power_line",
            "height": power_wire_height(tags),
            "voltage": tags.get("voltage"),
            "cables": tags.get("cables"),
            "wires": tags.get("wires"),
            "name": tags.get("name"),
            "ref": tags.get("ref"),
            "operator": tags.get("operator"),
        }
        features.append(
            {
                "type": "feature",
                "id": feature_id,
                "geometry": json.loads(shapely.to_geojson(part)),
                "properties": {
                    key: value for key, value in properties.items() if value is not None
                },
            }
        )
    return features


def to_building(
    feature_id,
    tags,
    s,
    distributions=None,
    solar_buildings=None,
    override: BuildingOverride | None = None,
) -> dict | None:
    """Build a building or building-part feature with imputed tags."""
    if s.geom_type == "Point":
        logger.warning(f"Point building?? {feature_id}")
        return None
    if s.geom_type not in ("Polygon", "MultiPolygon"):
        # don't abort the whole tile run over one weird feature
        logger.warning(f"non-polygon building?? {feature_id} ({s.geom_type})")
        return None
    base = building_base(tags)
    height = building_top(tags, base)

    values, sampled = impute(tags, feature_id, distributions or {})
    if override is not None:
        if override.color:
            values["color"] = override.color
            sampled = [field for field in sampled if field != "color"]
        if override.roof_color:
            values["roof_color"] = override.roof_color
            sampled = [field for field in sampled if field != "roof_color"]
        if override.roof_shape:
            values["roof_shape"] = override.roof_shape
            sampled = [field for field in sampled if field != "roof_shape"]
    properties = {
        "cmtype": "building",
        "height": height,
        "base": base or None,
        "name": tags.get("name"),
        "street": tags.get("addr:street"),
        "housenumber": tags.get("addr:housenumber"),
        # a curtain wall: the frontend drops the windows/balconies/door and gives
        # the walls their own glass material. Never imputed: a glass look is a
        # statement about the real facade, not something to invent.
        "glass": is_glass(tags) or None,
        # a church is an ordinary building=* polygon, so the value that says so
        # (church, chapel, cathedral, ...) has to be reported; religion only
        # matters for a place of worship that is not tagged by building value
        "building": tags.get("building"),
        "religion": (
            tags.get("religion") if tags.get("amenity") == "place_of_worship" else None
        ),
        # color, roof_shape and roof_color: the OSM tag when present, otherwise
        # a sample from the dataset's own distribution (see tilegen/impute.py).
        # `imputed` names the fields that were sampled rather than tagged.
        **values,
        "facade": override.facade if override else None,
        "imputed": sampled or None,
        # a building carrying mapped solar panels keeps a flat top so the
        # panels sit on it instead of disappearing inside a pitched roof
        "solar": (
            True if solar_buildings and str(feature_id) in solar_buildings else None
        ),
    }
    if override is not None and override.model is not None:
        properties["model"] = {
            "file": override.model.file,
            "scale": override.model.scale,
            "rotation": override.model.rotation,
            "offset": list(override.model.offset),
        }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


CONIFER_GENERA = (
    "pinus",
    "abies",
    "picea",
    "larix",
    "cedrus",
    "cupressus",
    "thuja",
    "juniperus",
    "taxus",
    "pseudotsuga",
)


def tree_type_size(tags, seed: int) -> tuple[str, float]:
    """(type, crown radius in meters) for a tree/row. Type comes from OSM tags
    (leaf_type, then genus/species) when present, otherwise from the seed."""
    leaf = str(tags.get("leaf_type", "")).lower()
    if leaf == "needleleaved":
        tree_type = "conifer"
    elif leaf == "broadleaved":
        tree_type = "broadleaf"
    else:
        species = f"{tags.get('genus', '')} {tags.get('species', '')}".lower()
        if any(genus in species for genus in CONIFER_GENERA):
            tree_type = "conifer"
        else:
            tree_type = "conifer" if seed % 3 == 0 else "broadleaf"

    crown = parse_length(tags.get("diameter_crown"))
    height = parse_length(tags.get("height"))
    if crown:
        size = crown / 2
    elif height:
        size = height * 0.25
    else:
        size = 1.3 + (seed % 7) * 0.12
    return tree_type, round(size, 2)


def to_tree(feature_id, tags, s) -> dict | None:
    """Build a point tree feature."""
    if s.geom_type != "Point":
        logger.warning(f"non-point tree?? {feature_id}")
        return None
    tree_type, size = tree_type_size(tags, zlib.crc32(str(feature_id).encode()))
    properties = {"cmtype": "tree", "type": tree_type, "size": size}
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def to_tree_row(feature_id, tags, s) -> dict | None:
    """Build a line tree-row feature."""
    if s.geom_type != "LineString":
        logger.warning(f"non-line tree_row?? {feature_id}")
        return None
    # a row shares one type/size; the frontend gives every sampled tree the
    # same values
    tree_type, size = tree_type_size(tags, zlib.crc32(str(feature_id).encode()))
    properties = {"cmtype": "tree_row", "type": tree_type, "size": size}
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


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


def bench_direction(tags) -> float | None:
    """The way a bench faces, in degrees clockwise from north, or None when the
    tag says nothing usable. "parallel"/"perpendicular" describe the bench
    relative to a nearby way that is not part of the data, so they are ignored,
    as is anything else that is not a compass letter or a number."""
    value = str(tags.get("direction", "")).strip().upper()
    if value in COMPASS:
        return COMPASS[value]
    try:
        return float(value) % 360
    except ValueError:
        return None


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


def to_bench(feature_id, tags, s) -> dict | None:
    """A bench as a point render feature. A bench mapped as a way collapses to
    the midpoint of the line, with the facing taken along it; benches come in
    thousands, so the properties stay minimal (the frontend derives everything
    else)."""
    if s.geom_type == "Point":
        direction = bench_direction(tags)
    elif s.geom_type == "LineString":
        direction = bench_direction(tags)
        if direction is None:
            direction = line_bearing(s)
        s = s.interpolate(0.5, normalized=True)
    else:
        # one stray Polygon bench (and anything odder) must not abort the tile
        logger.warning(f"non-point/line bench?? {feature_id} ({s.geom_type})")
        return None
    properties = {"cmtype": "bench", "direction": direction}
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


# water areas: bodies of water mapped as polygons. `water` alone catches the
# water=* areas that carry no natural=water.
WATER_NATURAL = frozenset({"water", "bay", "strait", "wetland"})
WATER_LANDUSE = frozenset({"reservoir", "basin"})
# linear waterways: the frontend buffers these into ribbons, so only the classes
# that are actually a visible channel are kept (a weir or a waterfall is not)
WATERWAY_KINDS = frozenset({"river", "canal", "stream", "drain", "ditch"})


def water_kind(tags) -> str | None:
    """The water sub-kind ("lake", "river", ...) the frontend colors and sizes
    by, or None when the feature is not water at all."""
    natural = tags.get("natural")
    if natural in WATER_NATURAL:
        return tags.get("water") or ("wetland" if natural == "wetland" else "lake")
    if tags.get("landuse") in WATER_LANDUSE:
        return tags.get("water") or tags["landuse"]
    if tags.get("waterway") in ("riverbank", "dock"):
        return tags.get("water") or "lake"
    if "water" in tags:
        return tags.get("water") or "lake"
    return None


def is_water(tags) -> bool:
    """Whether the tags describe an OSM water area or waterway."""
    return water_kind(tags) is not None or tags.get("waterway") in WATERWAY_KINDS


# green areas: parks, woods, lawns and pitches. The frontend draws them with a
# shader that has two styles, so each feature is classified into the style it
# wants. "grass" is a mown lawn / pitch / garden, "dense" a park, wood or scrub.
# Farmland is deliberately absent: there are thousands of farmland polygons and
# they would green the whole province.
GREEN_GRASS_LANDUSE = frozenset(
    {"grass", "village_green", "meadow", "recreation_ground"}
)
GREEN_GRASS_NATURAL = frozenset({"grassland", "grass"})
GREEN_GRASS_LEISURE = frozenset({"garden", "pitch"})
GREEN_DENSE_LEISURE = frozenset({"park", "common", "nature_reserve"})
GREEN_DENSE_NATURAL = frozenset({"wood", "scrub", "heath"})
GREEN_DENSE_LANDUSE = frozenset({"forest", "orchard"})

# a green area below this many square meters (after clipping to the tile) is
# dropped: a tile boundary clips a park into slivers, and thousands of specks
# cost geometry for no visible green.
MIN_GREEN_AREA = 40.0


def green_kind(tags) -> str | None:
    """The shader style ("grass" or "dense") a green area wants, or None when
    the feature is not green at all."""
    if tags.get("landuse") in GREEN_GRASS_LANDUSE:
        return "grass"
    if tags.get("natural") in GREEN_GRASS_NATURAL:
        return "grass"
    if tags.get("leisure") in GREEN_GRASS_LEISURE:
        return "grass"
    if tags.get("leisure") in GREEN_DENSE_LEISURE:
        return "dense"
    if tags.get("natural") in GREEN_DENSE_NATURAL:
        return "dense"
    if tags.get("landuse") in GREEN_DENSE_LANDUSE:
        return "dense"
    return None


def is_green(tags) -> bool:
    return green_kind(tags) is not None


# cemeteries: the ground is a clipped polygon like a park; the frontend fills it
# with procedural rows of tombstones. Kept as its own cmtype so the frontend can
# use a stone/grass palette instead of the park shader.
MIN_CEMETERY_AREA = 80.0


# paths: only the ways that actually pass through a park or green area. The
# sidewalk mapper already draws `footway=sidewalk` along roads, so those are not
# park paths, and a path underground or behind a private gate is not visible.
PARK_PATH_HIGHWAYS = frozenset({"footway", "path", "cycleway", "bridleway"})
PARK_PATH_EXCLUDED_FOOTWAY = frozenset({"sidewalk", "crossing"})


def is_park_path(tags) -> bool:
    """Whether a way is a foot/cycle path suitable for the park layer."""
    if tags.get("highway") not in PARK_PATH_HIGHWAYS:
        return False
    if tags.get("footway") in PARK_PATH_EXCLUDED_FOOTWAY:
        return False
    if tags.get("area") == "yes" or tags.get("indoor") == "yes":
        return False
    if tags.get("access") in ("private", "no"):
        return False
    return not (tags.get("location") == "underground" or tags.get("tunnel") == "yes")


def park_path_kind(tags) -> str:
    """`bike` wins a shared path: the bicycle is the faster, more distinctive
    surface to show, and `bicycle=designated` is explicit OSM intent."""
    if tags.get("highway") == "cycleway":
        return "bike"
    if tags.get("bicycle") in ("designated", "yes"):
        return "bike"
    return "walk"


def to_park_path(feature_id, tags, s, green_union, tile_box) -> dict | None:
    """The part of a foot/cycle path that falls inside green space and the tile.

    Clipping to the union of the tile's green polygons means a long riverside
    path stops at the park boundary instead of running through the city, and a
    path crossing a tile boundary is stored only once per tile.
    """
    if not is_park_path(tags) or s.geom_type not in ("LineString", "MultiLineString"):
        return None
    captured = s.intersection(green_union)
    if captured.is_empty:
        return None
    captured = captured.intersection(tile_box)
    line = _flatten(captured, "LineString")
    if line is None:
        return None
    width = parse_length(tags.get("width"))
    properties = {
        "cmtype": "park_path",
        "kind": park_path_kind(tags),
        "surface": tags.get("surface"),
        "width": width,
        "name": tags.get("name"),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(line)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def is_cemetery(tags) -> bool:
    """Whether the tags describe a cemetery area."""
    return tags.get("landuse") == "cemetery" or tags.get("amenity") == "grave_yard"


def to_cemetery(feature_id, tags, s, tile_box) -> dict | None:
    """A cemetery area, clipped to the tile like a park. The individual graves
    are not mapped in enough places to render, so the frontend lays out rows of
    simple tombstones inside this polygon."""
    if s.geom_type not in ("Polygon", "MultiPolygon"):
        return None
    clipped = _flatten(s.intersection(tile_box), "Polygon")
    if clipped is None or area_square_meters(clipped) < MIN_CEMETERY_AREA:
        return None
    properties = {
        "cmtype": "cemetery",
        "name": tags.get("name"),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


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


def to_water(feature_id, tags, s, tile_box) -> dict | None:
    """A water body as a render feature: an area (polygon), or a waterway line
    the frontend buffers into a ribbon.

    The geometry is clipped to the tile, unlike buildings (small enough to store
    whole in every tile): a lake or a long canal spans many tiles, and storing
    its full outline in each would both bloat the tile and draw the same water
    surface over and over."""
    kind = water_kind(tags)
    if kind is None:
        kind = tags.get("waterway")
        if kind not in WATERWAY_KINDS:
            return None
    want = "Polygon" if s.geom_type in ("Polygon", "MultiPolygon") else "LineString"
    clipped = _flatten(s.intersection(tile_box), want)
    if clipped is None:
        return None
    properties = {
        "cmtype": "water",
        "water": kind,
        "name": tags.get("name"),
        # the OSM vertical position: `layer` when set (Seveso is layer=-2, a
        # culverted river below ground), else `level`. Negative is below ground;
        # the frontend draws those faint.
        "layer": vertical_level(tags),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


# a bridge is a way carrying `bridge` (any value other than "no"): the common
# `bridge=yes`, plus the viaducts/aqueducts/covered/boardwalk. `man_made=bridge`
# is the deck drawn as its own polygon, and `building=bridge` is a bridge
# mis-mapped as a building (the diary flags it: it used to get a full roof and
# facade); both become a deck here instead.
def is_bridge(tags) -> bool:
    """Whether the tags describe a bridge way or footprint."""
    if tags.get("man_made") == "bridge" or tags.get("building") == "bridge":
        return True
    # a carried way: the deck only makes sense for a road or rail class
    return tags.get("bridge") not in (None, "no") and transport_class(tags) is not None


# a tunnel is a way carrying `tunnel` (any value other than "no"). A
# building_passage is an arcade under a house and a culvert is a drain: neither
# is a road tunnel the user would recognize, so they stay out.
TUNNEL_SKIP = frozenset({"no", "culvert", "building_passage"})


def is_tunnel(tags) -> bool:
    """Whether the tags describe a tunnel way."""
    return tags.get("tunnel") is not None and tags.get("tunnel") not in TUNNEL_SKIP


# the only tunnels worth a portal: roads and railways. Most `tunnel=yes` ways in
# the extract are footway/steps underpasses (thousands of them), which are not
# the road tunnel the user pictures and would bury the scene in tiny frames.
PORTAL_CLASSES = frozenset(
    {
        "motorway",
        "motorway_link",
        "trunk",
        "trunk_link",
        "primary",
        "primary_link",
        "secondary",
        "secondary_link",
        "tertiary",
        "tertiary_link",
        "residential",
        "unclassified",
        "living_street",
        "service",
        "rail",
        "light_rail",
        "narrow_gauge",
        "tram",
    }
)


# the road/rail class a bridge carries; the frontend turns it into a deck width
def transport_class(tags) -> str | None:
    """The highway/railway class a bridge or tunnel carries."""
    return tags.get("highway") or tags.get("railway")


def to_bridge(feature_id, tags, s, tile_box) -> dict | None:
    """A bridge as a render feature: a way's line (the deck the frontend raises
    into a slab), or a `man_made=bridge` / `building=bridge` polygon (the deck
    footprint, drawn as a slab).

    Like water, the geometry is clipped to the tile: a bridge crosses several
    tiles and storing it whole in each would draw it over and over. Tunnels are
    handled separately (they only show as portals)."""
    if s.geom_type in ("Polygon", "MultiPolygon"):
        clipped = _flatten(s.intersection(tile_box), "Polygon")
    else:
        clipped = _flatten(s.intersection(tile_box), "LineString")
    if clipped is None:
        return None
    properties = {
        "cmtype": "bridge",
        # the OSM `layer` when set (a deck above a road is 1); the frontend uses
        # it as the deck height proxy
        "layer": vertical_level(tags),
        "class": transport_class(tags),
        # the deck footprint is a bridge in its own right; give it a value so
        # the frontend can tell it apart from a carried way if it ever wants to
        "bridge": tags.get("bridge") or "deck",
        "name": tags.get("name"),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def portal_angle(lon0: float, lat0: float, lon1: float, lat1: float) -> float:
    """The tunnel's direction at a portal, as the atan2 in model space. Lon/lat
    are not isotropic (a degree of longitude is `cos(lat)` of a degree of
    latitude in meters), so the scale is folded in here rather than making the
    frontend redo it."""
    dx = (lon1 - lon0) * math.cos(math.radians(lat0))
    dy = lat1 - lat0
    return math.atan2(dy, dx)


def tunnel_portals(s, tile_box) -> list[tuple[Point, float]]:
    """The true ends of a tunnel way that lie inside the tile, with the tunnel's
    direction there: where the tunnel meets the surface, i.e. a portal. Emitting
    the clipped line instead would put a portal on every tile boundary, which is
    not a portal at all."""
    ends: list[tuple[Point, float]] = []
    for part in shapely.get_parts(s):
        if part.geom_type != "LineString":
            continue
        coords = list(part.coords)
        if len(coords) < 2:
            continue
        for point, neighbour in ((coords[0], coords[1]), (coords[-1], coords[-2])):
            if tile_box.contains(Point(point)):
                ends.append(
                    (
                        Point(point),
                        portal_angle(point[0], point[1], neighbour[0], neighbour[1]),
                    )
                )
    return ends


def to_tunnel(feature_id, tags, s, tile_box) -> list[dict]:
    """A tunnel's portal(s): a Point per end of the way that falls in the tile,
    carrying the tunnel's direction. The underground part is deliberately not
    drawn — a tunnel is invisible, and the honest, visible thing is the opening
    where it meets the surface. A way whose ends are all outside the tile (the
    tunnel merely passes under it) contributes nothing."""
    transport = transport_class(tags)
    if transport not in PORTAL_CLASSES:
        return []
    portal = {
        "cmtype": "tunnel",
        "layer": vertical_level(tags),
        "class": transport,
        "name": tags.get("name"),
    }
    properties = {k: v for k, v in portal.items() if v is not None}
    return [
        {
            "type": "feature",
            "id": feature_id,
            "geometry": json.loads(shapely.to_geojson(point)),
            "properties": {**properties, "angle": round(angle, 4)},
        }
        for point, angle in tunnel_portals(s, tile_box)
    ]


def to_green(feature_id, tags, s, tile_box) -> dict | None:
    """A green area as a render feature, clipped to the tile like water (a park
    spans many tiles). The `green` sub-kind selects the frontend shader style."""
    kind = green_kind(tags)
    if kind is None or s.geom_type not in ("Polygon", "MultiPolygon"):
        return None
    clipped = _flatten(s.intersection(tile_box), "Polygon")
    if clipped is None or area_square_meters(clipped) < MIN_GREEN_AREA:
        return None
    properties = {
        "cmtype": "green",
        "green": kind,
        "name": tags.get("name"),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


# small street furniture: one point per object, so the frontend can build a
# low-poly prop and merge the tile's props into one mesh. Bench is handled
# separately (it carries a direction); these are the anonymous pieces.
FURNITURE_KINDS = (
    ("barrier", "bollard", "bollard"),
    ("amenity", "waste_basket", "bin"),
    ("amenity", "bicycle_parking", "bike_rack"),
    ("amenity", "post_box", "post_box"),
    ("amenity", "drinking_water", "drinking_water"),
    ("tourism", "information", "info_board"),
    ("emergency", "fire_hydrant", "hydrant"),
)


def furniture_kind(tags) -> str | None:
    """The prop kind a street-furniture tag wants, or None."""
    for key, value, kind in FURNITURE_KINDS:
        if tags.get(key) == value:
            return kind
    return None


# food/drink places whose outdoor seating we can turn into a terrace; a stray
# pharmacy or bench with the tag is not a cafe
TERRACE_AMENITIES = frozenset(
    {"restaurant", "cafe", "bar", "pub", "fast_food", "ice_cream", "biergarten"}
)


def is_terrace(tags) -> bool:
    value = tags.get("outdoor_seating")
    return (
        value is not None and value != "no" and tags.get("amenity") in TERRACE_AMENITIES
    )


def terrace_place(point, road, building_tree, buildings, offset_max: float = 8.0):
    """Move a terrace from the cafe point to the nearest point by the road that
    is not inside a building. OSM often puts the cafe node inside the building;
    a small step toward the cafe from the road stays at the kerb only until the
    facade starts, so test candidates from the widest inward step and take the
    first one outside every footprint."""
    nearest = road.interpolate(road.project(point))
    distance = point.distance(nearest)
    if distance < 1e-6:
        return nearest
    ux = (point.x - nearest.x) / distance
    uy = (point.y - nearest.y) / distance
    candidates = [offset_max, 7.0, 6.0, 5.0, 4.0, 3.0, 2.0, 1.5, 1.0, 0.5]
    for offset in candidates:
        if offset > distance:
            continue
        candidate = Point(nearest.x + ux * offset, nearest.y + uy * offset)
        hits = building_tree.query(candidate)
        if not any(buildings[int(index)].contains(candidate) for index in hits):
            return candidate
    return nearest


def to_terrace(feature_id, tags, s, position=None) -> dict | None:
    """An outdoor terrace as a point. The umbrellas/tables are procedural; the
    amenity value only picks the popup label and the OSM link. `position` is the
    precomputed sidewalk point (see terrace_positions_from_parquet)."""
    if not is_terrace(tags):
        return None
    if position is not None:
        point = Point(position)
    elif s.geom_type == "Point":
        point = s
    elif s.geom_type == "LineString":
        point = s.interpolate(0.5, normalized=True)
    elif s.geom_type in ("Polygon", "MultiPolygon"):
        point = s.centroid
    else:
        return None
    if point.is_empty:
        return None
    properties = {"cmtype": "terrace", "terrace": tags["amenity"]}
    if tags.get("name"):
        properties["name"] = tags["name"]
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(point)),
        "properties": properties,
    }


RAIL_KINDS = frozenset({"rail", "tram"})


def is_rail(tags) -> bool:
    """Whether the tags describe an above-ground rail/tram way."""
    return tags.get("railway") in RAIL_KINDS


def is_rail_platform(tags) -> bool:
    """Rail/tram platforms, not the bus platforms that share the OSM tags."""
    if tags.get("bus") == "yes" and not (
        tags.get("train") == "yes" or tags.get("tram") == "yes"
    ):
        return False
    if tags.get("railway") == "platform":
        return True
    return tags.get("public_transport") == "platform" and (
        tags.get("train") == "yes" or tags.get("tram") == "yes"
    )


def to_platform(feature_id, tags, s, tile_box) -> dict | None:
    """A rail platform as a clipped area. OSM often maps the platform as an
    edge line rather than a closed polygon, so buffer those to a 4 m ribbon."""
    if tags.get("bus") == "yes" and not (
        tags.get("train") == "yes" or tags.get("tram") == "yes"
    ):
        return None
    if s.geom_type in ("LineString", "MultiLineString"):
        s = s.buffer(2.0 / 111_000, cap_style="flat", join_style=2)
    clipped = _flatten(s.intersection(tile_box), "Polygon")
    if clipped is None or area_square_meters(clipped) < 15:
        return None
    properties = {
        "cmtype": "platform",
        "name": tags.get("name"),
        "ref": tags.get("ref"),
        "kind": tags.get("railway") or "platform",
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def to_rail(feature_id, tags, s, tile_box) -> dict | None:
    """A rail or tram way clipped to the tile. Underground, covered and
    bridge-deck tracks are skipped: the first are invisible and the last would
    otherwise be painted on the ground under the deck."""
    if s.geom_type not in ("LineString", "MultiLineString"):
        return None
    if tags.get("tunnel") in ("yes", "building_passage", "covered", "culvert"):
        return None
    if tags.get("bridge") not in (None, "no"):
        return None
    layer = parse_length(tags.get("layer"))
    if layer not in (None, 0):
        return None
    clipped = _flatten(s.intersection(tile_box), "LineString")
    if clipped is None:
        return None
    properties = {
        "cmtype": "rail",
        "kind": tags.get("railway"),
        "name": tags.get("name"),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def is_construction(tags) -> bool:
    """Whether the tags describe a construction site."""
    return tags.get("landuse") == "construction"


def to_construction(feature_id, tags, s, tile_box) -> dict | None:
    """A construction site clipped to the tile like a park. The tile that holds
    the site centroid also carries the crane flag and the full site area, so a
    site spanning several tiles builds its cranes only once."""
    if s.geom_type not in ("Polygon", "MultiPolygon"):
        return None
    clipped = _flatten(s.intersection(tile_box), "Polygon")
    if clipped is None or area_square_meters(clipped) < 80:
        return None
    properties = {
        "cmtype": "construction",
        "construction": tags.get("construction"),
        "name": tags.get("name"),
    }
    centroid = s.centroid
    if centroid.within(tile_box):
        properties["crane"] = True
        properties["site_area"] = round(area_square_meters(s))
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def is_playground(tags) -> bool:
    """Whether the tags describe a playground."""
    return tags.get("leisure") == "playground"


def to_playground(feature_id, tags, s) -> dict | None:
    """A playground as a point with a radius-like size. The equipment is
    procedural; a mapped polygon gives a sensible spread, a node a default
    ten-meter playground."""
    if not is_playground(tags):
        return None
    size = 10.0
    if s.geom_type == "Point":
        point = s
    elif s.geom_type == "LineString":
        point = s.interpolate(0.5, normalized=True)
    elif s.geom_type in ("Polygon", "MultiPolygon"):
        point = s.centroid
        area = area_square_meters(s)
        size = max(6.0, min(18.0, 2.0 * math.sqrt(area / math.pi)))
    else:
        return None
    if point.is_empty:
        return None
    properties = {"cmtype": "playground", "size": round(size, 2)}
    if tags.get("name"):
        properties["name"] = tags["name"]
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(point)),
        "properties": properties,
    }


def monument_kind(tags) -> str | None:
    """The monument sub-kind for a historic/man_made feature."""
    if tags.get("man_made") == "obelisk":
        return "obelisk"
    if tags.get("historic") == "monument":
        return "monument"
    if tags.get("historic") == "memorial":
        return "memorial"
    return None


def is_monument(tags) -> bool:
    """Whether the tags describe a monument or memorial."""
    return monument_kind(tags) is not None


def to_monument(feature_id, tags, s) -> dict | None:
    """A monument/memorial as a point; the frontend picks a pedestal/statue/
    obelisk/plaque from the kind and the `memorial` sub-tag."""
    kind = monument_kind(tags)
    if kind is None:
        return None
    if s.geom_type == "Point":
        point = s
    elif s.geom_type == "LineString":
        point = s.interpolate(0.5, normalized=True)
    elif s.geom_type in ("Polygon", "MultiPolygon"):
        point = s.centroid
    else:
        return None
    if point.is_empty:
        return None
    properties = {"cmtype": "monument", "kind": kind}
    if tags.get("memorial"):
        properties["memorial"] = tags["memorial"]
    if tags.get("name"):
        properties["name"] = tags["name"]
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(point)),
        "properties": properties,
    }


def transit_kind(tags) -> str | None:
    """The stop kind a tag pair names, or None. Metro wins over a bus stop on
    the same node; trams are their own kind because the sign is the same but the
    popup should say so."""
    if tags.get("railway") == "subway_entrance":
        return "metro"
    if tags.get("railway") == "tram_stop":
        return "tram"
    if tags.get("highway") == "bus_stop":
        return "bus"
    return None


def to_transit_stop(feature_id, tags, s) -> dict | None:
    """A metro entrance, tram stop or bus stop as a point. Shelters are a
    property (both the covered and the implied ones); the frontend draws the
    pole/sign for all stops and adds the shelter when it is set."""
    kind = transit_kind(tags)
    if kind is None:
        return None
    if s.geom_type == "Point":
        point = s
    elif s.geom_type == "LineString":
        point = s.interpolate(0.5, normalized=True)
    elif s.geom_type in ("Polygon", "MultiPolygon"):
        point = s.centroid
    else:
        return None
    if point.is_empty:
        return None
    properties = {"cmtype": "transit_stop", "stop": kind}
    if tags.get("name"):
        properties["name"] = tags["name"]
    if kind != "metro" and (
        tags.get("shelter") == "yes" or tags.get("covered") == "yes"
    ):
        properties["shelter"] = True
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(point)),
        "properties": properties,
    }


def to_fountain(feature_id, tags, s) -> dict | None:
    """A fountain as a point render feature. A mapped area collapses to its
    centroid and its equivalent diameter (clamped, so a whole square mapped as
    one fountain does not become a lake); a node keeps a small default size."""
    if tags.get("amenity") != "fountain":
        return None
    size = 2.4
    if s.geom_type == "Point":
        point = s
    elif s.geom_type == "LineString":
        point = s.interpolate(0.5, normalized=True)
    elif s.geom_type in ("Polygon", "MultiPolygon"):
        point = s.centroid
        area = area_square_meters(s)
        size = max(1.5, min(12.0, 2.0 * math.sqrt(area / math.pi)))
    else:
        return None
    if point.is_empty:
        return None
    properties = {
        "cmtype": "fountain",
        "size": round(size, 2),
        "name": tags.get("name"),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(point)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def to_furniture(feature_id, tags, s) -> dict | None:
    """A street-furniture point. Areas (bike parking) collapse to their
    centroid; a line (a rack mapped as a way) keeps its bearing so the frontend
    can line the rack up with the kerb."""
    kind = furniture_kind(tags)
    if kind is None:
        return None
    angle = None
    if s.geom_type == "Point":
        point = s
    elif s.geom_type == "LineString":
        angle = line_bearing(s)
        point = s.interpolate(0.5, normalized=True)
    elif s.geom_type in ("Polygon", "MultiPolygon"):
        point = s.centroid
    else:
        return None
    if point.is_empty:
        return None
    properties = {"cmtype": "furniture", "furniture": kind}
    if angle is not None:
        properties["angle"] = round(angle, 4)
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(point)),
        "properties": properties,
    }


# barriers drawn as a line the frontend can build a fence band along. `fence` is
# the core; a guard rail or a railing is the same shape with a metal color, so
# they come along for free (the frontend colors by the `barrier` sub-kind).
FENCE_BARRIERS = frozenset({"fence", "guard_rail", "railing"})
WALL_BARRIERS = frozenset({"wall", "retaining_wall", "city_wall", "hoarding"})
GATE_BARRIERS = frozenset(
    {"gate", "lift_gate", "swing_gate", "wicket_gate", "sliding_gate"}
)
# a clip can leave a stub of fence a few centimeters long at a tile edge; it
# still costs a vertex band and a draw, and reads as nothing. The geometry here
# is in degrees (the tile box is lon/lat), so this is ~1 m at Milan's latitude.
MIN_FENCE_LENGTH = 1e-5


def fence_lines(geometry, tile_box, min_length: float = MIN_FENCE_LENGTH):
    """The barrier's line clipped to the tile, as a LineString / MultiLineString,
    or None when nothing long enough is left. Pure, so it is unit-tested."""
    clipped = _flatten(geometry.intersection(tile_box), "LineString")
    if clipped is None:
        return None
    parts = [part for part in shapely.get_parts(clipped) if part.length >= min_length]
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    return shapely.MultiLineString(parts)


def to_wall(feature_id, tags, s, tile_box) -> dict | None:
    """Build a low wall feature clipped to the tile."""
    barrier = tags.get("barrier")
    if barrier not in WALL_BARRIERS and not tags.get("wall"):
        return None
    geometry = s.boundary if s.geom_type in ("Polygon", "MultiPolygon") else s
    if geometry.geom_type not in ("LineString", "MultiLineString"):
        return None
    clipped = fence_lines(geometry, tile_box)
    if clipped is None:
        return None
    properties = {
        "cmtype": "wall",
        "wall": tags.get("wall") or barrier,
        "height": parse_length(tags.get("height")),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def to_gate(feature_id, tags, s, gate_bearings: dict[int, float] | None) -> dict | None:
    """Build a gate as two posts and a leaf."""
    if s.geom_type != "Point" or tags.get("barrier") not in GATE_BARRIERS:
        return None
    bearing = (gate_bearings or {}).get(feature_id)
    if bearing is None:
        return None
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {
            "cmtype": "gate",
            "bearing": round(bearing, 1),
            "width": 3.0,
        },
    }


def to_fence(feature_id, tags, s, tile_box) -> dict | None:
    """A barrier as a line the frontend turns into a fence band: a
    `barrier=fence` way (or guard rail / railing), or the outline of one drawn
    as a closed area.

    Like water, the line is clipped to the tile: a fence runs along a plot
    boundary across several tiles, and storing it whole in each would draw it
    over and over (and the frontend band wants only what is in the tile)."""
    barrier = tags.get("barrier")
    if barrier not in FENCE_BARRIERS:
        return None
    # a barrier closed into an area (a fenced enclosure) is a footprint: its
    # outline is the fence, and it clips and draws like any other line
    geometry = s.boundary if s.geom_type in ("Polygon", "MultiPolygon") else s
    if geometry.geom_type not in ("LineString", "MultiLineString"):
        return None
    clipped = fence_lines(geometry, tile_box)
    if clipped is None:
        return None
    properties = {
        "cmtype": "fence",
        "barrier": barrier,
        "name": tags.get("name"),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


# airport surfaces the frontend draws as flat tarmac. The lines (runways,
# taxiways) are buffered to a ribbon by their width; the areas (aprons,
# helipad polygons) are drawn as polygons.
AEROWAY_LINE_KINDS = frozenset({"runway", "taxiway"})
AEROWAY_AREA_KINDS = frozenset({"apron", "helipad"})
# fallback widths in meters when OSM has no `width` tag: a runway is wide
# enough for an airliner, a taxiway a third of that
DEFAULT_AEROWAY_WIDTH = {"runway": 45.0, "taxiway": 15.0}


def to_aeroway(feature_id, tags, s) -> dict | None:
    """An airport surface as a render feature: a runway/taxiway line (the
    frontend buffers it with the width below) or an apron/helipad area.

    Unlike water, the geometry is stored whole in every tile it touches, not
    clipped: a runway is a single narrow line, and a piece of it would read as
    an orphan stripe at the tile edge (also the surface has to line up with the
    plane path, which the frontend derives from the same line). The frontend
    dedupes runways by id before using them."""
    kind = tags.get("aeroway")
    if kind in AEROWAY_LINE_KINDS:
        if s.geom_type not in ("LineString", "MultiLineString"):
            logger.warning(f"non-line {kind}?? {feature_id} ({s.geom_type})")
            return None
        width = parse_length(tags.get("width")) or DEFAULT_AEROWAY_WIDTH[kind]
    elif kind in AEROWAY_AREA_KINDS:
        if s.geom_type not in ("Polygon", "MultiPolygon"):
            # a helipad is often a bare node; nothing to draw for it
            return None
        width = None
    else:
        return None
    properties = {"cmtype": "aeroway", "aeroway": kind, "width": width}
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }
