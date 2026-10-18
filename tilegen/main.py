import json
import logging
import math
import re
import zlib
from collections import defaultdict
from pathlib import Path

import click
import duckdb
import quackosm as qosm
import shapely
from geo import TILE_ZOOM, coord_to_tile, tile_lonlat_bounds
from impute import IMPUTED_FIELDS, Distribution, impute
from shapely.geometry import LineString, MultiLineString, Point
from shapely.geometry.base import BaseGeometry
from traffic import (
    CAR_CONFIG,
    DRIVABLE_HIGHWAYS,
    RAILWAYS,
    STOP_KINDS,
    TRAIN_CONFIG,
    CrossingPoint,
    Loop,
    TrafficConfig,
    Way,
    build_fleets,
    fleets_cache_key,
    fleets_from_records,
    fleets_to_records,
    fleets_to_tiles,
    loop_coords,
    loop_report,
    loops_to_geojson,
    parse_maxspeed,
    road_oneway,
)

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

# where the loop report looks for the comune di Milano boundary by default.
# data/ is local-only, so if the file is missing the report GeoJSON keeps every
# loop instead of failing.
DEFAULT_REPORT_POLYGON = Path("../data/milano_polygon.json")


def pbf_to_parquet(input_pbf: Path, borders_shape: BaseGeometry | None = None) -> Path:
    gpq_path = qosm.convert_pbf_to_parquet(input_pbf, geometry_filter=borders_shape)
    logger.info(f"Extracted: {gpq_path}")
    return gpq_path


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


def vertical_level(tags) -> float | None:
    """A feature's OSM vertical position: `layer` when it is set (the tunnel /
    bridge ordering: Seveso is `layer=-2`, a bridge is `layer=1`), else `level`.
    Negative means below ground."""
    return parse_level(tags.get("layer") or tags.get("level"))


def to_building(feature_id, tags, s, distributions=None) -> dict | None:
    if s.geom_type == "Point":
        logger.warning(f"Point building?? {feature_id}")
        return None
    if s.geom_type not in ("Polygon", "MultiPolygon"):
        # don't abort the whole tile run over one weird feature
        logger.warning(f"non-polygon building?? {feature_id} ({s.geom_type})")
        return None
    height = parse_length(tags.get("height"))
    if height is None and "building:levels" in tags:
        levels = parse_length(tags["building:levels"])
        if levels is not None:
            height = levels * 3

    values, sampled = impute(tags, feature_id, distributions or {})
    properties = {
        "cmtype": "building",
        "height": height,
        "name": tags.get("name"),
        "street": tags.get("addr:street"),
        "housenumber": tags.get("addr:housenumber"),
        # color, roof_shape and roof_color: the OSM tag when present, otherwise
        # a sample from the dataset's own distribution (see tilegen/impute.py).
        # `imputed` names the fields that were sampled rather than tagged.
        **values,
        "imputed": sampled or None,
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
    return to_stop_point(feature_id, tags, s, "traffic_signal")


def to_crossing(feature_id, tags, s) -> dict | None:
    return to_stop_point(feature_id, tags, s, "crossing")


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
    return water_kind(tags) is not None or tags.get("waterway") in WATERWAY_KINDS


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
    if tags.get("man_made") == "bridge" or tags.get("building") == "bridge":
        return True
    # a carried way: the deck only makes sense for a road or rail class
    return tags.get("bridge") not in (None, "no") and transport_class(tags) is not None


# a tunnel is a way carrying `tunnel` (any value other than "no"). A
# building_passage is an arcade under a house and a culvert is a drain: neither
# is a road tunnel the user would recognize, so they stay out.
TUNNEL_SKIP = frozenset({"no", "culvert", "building_passage"})


def is_tunnel(tags) -> bool:
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


def tile_to_geojson(
    data,
    tile_x: int,
    tile_y: int,
    zoom: int,
    distributions: dict[str, Distribution] | None = None,
) -> tuple[list, list]:
    """Build the render features (buildings, trees, water) and the raw-tag
    features.

    The road and rail network is deliberately not emitted: the vehicle routes
    are precomputed wholesale in traffic.py (from the parquet), so the frontend
    never needs the network lines.
    """
    ret = []
    ret_raw = []
    # water is clipped to the tile, so its box is built once here
    min_lon, min_lat, max_lon, max_lat = tile_lonlat_bounds(tile_x, tile_y, zoom)
    tile_box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    for feature_id, tags, geometry in data:
        s = shapely.from_wkb(geometry)
        ret_raw.append(
            {
                "type": "feature",
                "id": feature_id,
                "geometry": json.loads(shapely.to_geojson(s)),
                "properties": tags,
            }
        )
        if is_bridge(tags):
            # before `building`: building=bridge is a bridge, not a house
            ret.append(to_bridge(feature_id, tags, s, tile_box))
        elif is_tunnel(tags) and transport_class(tags) in PORTAL_CLASSES:
            # before `water`: a culverted river keeps its water rendering (the
            # guard falls through), only a road/rail tunnel becomes a portal
            ret.extend(to_tunnel(feature_id, tags, s, tile_box))
        elif "building" in tags:
            ret.append(to_building(feature_id, tags, s, distributions))
        elif tags.get("natural") == "tree":
            ret.append(to_tree(feature_id, tags, s))
        elif tags.get("natural") == "tree_row":
            ret.append(to_tree_row(feature_id, tags, s))
        elif tags.get("highway") == "traffic_signals":
            ret.append(to_traffic_signal(feature_id, tags, s))
        elif tags.get("highway") == "crossing":
            ret.append(to_crossing(feature_id, tags, s))
        elif is_water(tags):
            ret.append(to_water(feature_id, tags, s, tile_box))

    return [r for r in ret if r is not None], ret_raw


def load_ways(
    input_parquet: Path,
    tag_key: str = "highway",
    allowed: frozenset[str] = DRIVABLE_HIGHWAYS,
) -> list[Way]:
    """Read every way with a `tag_key` value in `allowed` once from the parquet,
    for the global traffic graph. The per-tile pipeline clips and stitches
    independently, so it cannot be used here: loops must be found on the whole
    network at once."""
    rows = duckdb.execute(
        f"""
        select tags, ST_AsWKB(geometry)
        from read_parquet($input_path)
        where tags['{tag_key}'] is not null
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    ways: list[Way] = []
    for tags, wkb in rows:
        value = tags.get(tag_key)
        if value not in allowed:
            continue
        geometry = shapely.from_wkb(wkb)
        parts = geometry.geoms if isinstance(geometry, MultiLineString) else [geometry]
        # oneway only means anything on the road network
        oneway = road_oneway(tags) if tag_key == "highway" else None
        maxspeed = (
            parse_maxspeed(tags.get("maxspeed")) if tag_key == "highway" else None
        )
        for part in parts:
            if isinstance(part, LineString):
                ways.append(
                    Way(
                        coords=[(c[0], c[1]) for c in part.coords],
                        oneway=oneway,
                        highway=value,
                        maxspeed=maxspeed,
                    )
                )
    return ways


def crossing_points_from_rows(rows) -> list[CrossingPoint]:
    """Map query rows (highway tag value, WKB) to signal/crossing points, keeping
    only the node points. Split out from the query so it is unit-testable."""
    points: list[CrossingPoint] = []
    for value, wkb in rows:
        kind = STOP_KINDS.get(value)
        if kind is None:
            continue
        geometry = shapely.from_wkb(wkb)
        if geometry.geom_type != "Point":
            continue
        points.append(CrossingPoint(lon=geometry.x, lat=geometry.y, kind=kind))
    return points


def load_crossing_points(input_parquet: Path) -> list[CrossingPoint]:
    """Every signal/crossing node once, for the report. They are emitted as
    point features per tile too; this is the whole-area list the report clips to
    the polygon's extent. `traffic.py` takes them as plain inputs (no OSM I/O)."""
    rows = duckdb.execute(
        """
        select tags['highway'], ST_AsWKB(geometry)
        from read_parquet($input_path)
        where tags['highway'] in ('traffic_signals', 'crossing')
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    return crossing_points_from_rows(rows)


def write_loop_report(
    fleets: dict[str, list[Loop]],
    report_dir: Path,
    polygon: BaseGeometry | None,
    crossing_points: list[CrossingPoint] | None = None,
) -> None:
    """Write the loop-size report (`loops.md`) and the troubleshooting GeoJSON
    (`loops.geojson`). When `polygon` is given, the GeoJSON keeps only loops
    that intersect it (the comune di Milano by default)."""
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "loops.md").write_text(loop_report(fleets, crossing_points))
    features: list[dict] = []
    for loops in fleets.values():
        selected = loops
        if polygon is not None:
            selected = [
                loop
                for loop in loops
                if shapely.LineString(loop_coords(loop)).intersects(polygon)
            ]
        features.extend(loops_to_geojson(selected))
    features.extend(loops_to_geojson([], crossing_points))
    (report_dir / "loops.geojson").write_text(
        json.dumps(
            {"type": "FeatureCollection", "features": features},
            separators=(",", ":"),
            ensure_ascii=False,
        )
    )
    logger.info(f"loop report: {len(features)} features written to {report_dir}")


def tag_distribution(input_parquet: Path, tag_key: str) -> Distribution | None:
    """The distribution of one tag over every building that sets it, for
    sampling the buildings that don't (see tilegen/impute.py)."""
    rows = duckdb.execute(
        f"""
        select tags['{tag_key}'] as value, count(*) as count
        from read_parquet($input_path)
        where tags['building'] is not null
          and tags['{tag_key}'] is not null
        group by 1
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    distribution = Distribution.from_counts(
        {value: count for value, count in rows if value is not None}
    )
    if distribution is not None:
        logger.info(
            f"{tag_key}: {len(distribution.values)} distinct values, "
            f"{distribution.total} buildings"
        )
    return distribution


def building_distributions(input_parquet: Path) -> dict[str, Distribution]:
    """One distribution per imputed field, over the buildings that set the tag."""
    distributions: dict[str, Distribution] = {}
    for field, tag in IMPUTED_FIELDS:
        distribution = tag_distribution(input_parquet, tag)
        if distribution is not None:
            distributions[field] = distribution
    return distributions


def _in_list(values) -> str:
    return "(" + ", ".join(f"'{value}'" for value in sorted(values)) + ")"


# the SQL twin of `is_water`, for the level report (which runs over the parquet
# before the tiles exist, so it cannot reuse the Python predicate)
WATER_SQL = " or ".join(
    (
        f"tags['natural'] in {_in_list(WATER_NATURAL)}",
        f"tags['landuse'] in {_in_list(WATER_LANDUSE)}",
        f"tags['waterway'] in {_in_list(WATERWAY_KINDS | {'riverbank', 'dock'})}",
        "tags['water'] is not null",
    )
)


def _vertical_counts(input_parquet: Path, predicate: str) -> list[tuple]:
    """(vertical position, count) per feature matching `predicate`, taking
    `layer` when set (the tunnel/bridge ordering), else `level`."""
    return duckdb.execute(
        f"""
        select coalesce(tags['layer'], tags['level']) as value, count(*)
        from read_parquet($input_path)
        where ({predicate})
          and coalesce(tags['layer'], tags['level']) is not null
        group by 1
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()


def level_report(input_parquet: Path) -> None:
    """Report the OSM vertical positions that matter for rendering: water below
    ground (underwater, drawn faint in the frontend) and roads above or below it
    (bridges and tunnels; the road network itself is not emitted, the bridge and
    tunnel pass in `to_bridge`/`to_tunnel` reads them). The position is `layer`
    when set, else `level`."""
    water = _vertical_counts(input_parquet, WATER_SQL)
    underwater = sum(count for value, count in water if (parse_level(value) or 0) < 0)
    logger.info(
        f"water levels: {underwater} of {sum(count for _, count in water)} "
        "features below 0 (underwater, drawn faint)"
    )
    for value, count in sorted(water, key=lambda row: str(row[0])):
        logger.info(f"  water level {value!r}: {count}")

    roads = _vertical_counts(input_parquet, "tags['highway'] is not null")
    bridges = sum(count for value, count in roads if (parse_level(value) or 0) > 0)
    logger.info(
        f"road levels: {bridges} of {sum(count for _, count in roads)} ways "
        "above 0 (bridges, for a future pass)"
    )
    for value, count in sorted(roads, key=lambda row: str(row[0])):
        logger.info(f"  road level {value!r}: {count}")


def load_or_build_fleets(
    ways_by_kind: dict[str, list[Way]],
    configs: dict[str, TrafficConfig],
    cache_dir: Path,
    use_cache: bool,
) -> dict[str, list[Loop]]:
    """Per-kind loops, from the disk cache when one matches the inputs.

    The random car generator is one of the slowest steps (tens of minutes for a
    city-sized extract: thousands of A* searches over the whole road graph), so
    the result is cached under a hash of the ways and the configs. A rebuild
    only happens on a cache miss or with --no-cache.
    """
    if not use_cache:
        logger.info("Traffic loop cache disabled, building loops")
        return build_fleets(ways_by_kind, configs)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"loops-{fleets_cache_key(ways_by_kind, configs)}.json"
    if cache_path.exists():
        logger.info(f"Loading traffic loops from cache: {cache_path}")
        return fleets_from_records(json.loads(cache_path.read_text()))
    logger.info("Traffic loop cache miss, building loops")
    fleets = build_fleets(ways_by_kind, configs)
    cache_path.write_text(json.dumps(fleets_to_records(fleets), separators=(",", ":")))
    logger.info(f"Wrote traffic loops to cache: {cache_path}")
    return fleets


def group_features_by_tile(rows) -> dict[tuple[int, int], list[tuple]]:
    """(tile_x, tile_y) -> [(feature_id, tags, wkb)] from the grouped query.

    Each tile's features are sorted by id so a rebuild reproduces the same file
    even though the query's join/unnest order is not guaranteed."""
    by_tile: dict[tuple[int, int], list[tuple]] = defaultdict(list)
    for tile_x, tile_y, feature_id, tags, wkb in rows:
        by_tile[(tile_x, tile_y)].append((feature_id, tags, wkb))
    for features in by_tile.values():
        features.sort(key=lambda feature: feature[0])
    return by_tile


def parquet_features_by_tile(
    input_parquet: Path, zoom: int
) -> dict[tuple[int, int], list[tuple]]:
    """Every feature grouped by the tiles it intersects, from a single scan.

    The per-tile alternative ran one ST_Intersects query per tile over the whole
    parquet; the tile grid is mostly empty, so that scanned the file tens of
    thousands of times. Here each feature is placed in its envelope's tile range
    and filtered with the same ST_Intersects, so the result matches the per-tile
    query exactly."""
    rows = duckdb.execute(
        """
        with features as (
            select
                feature_id,
                tags,
                geometry,
                floor((ST_XMin(ST_Envelope(geometry)) + 180) / 360 * $n)::bigint
                    as min_tx,
                floor((ST_XMax(ST_Envelope(geometry)) + 180) / 360 * $n)::bigint
                    as max_tx,
                floor(
                    (
                        1 - ln(
                            tan(radians(ST_YMax(ST_Envelope(geometry))))
                            + 1 / cos(radians(ST_YMax(ST_Envelope(geometry))))
                        ) / pi()
                    ) / 2 * $n
                )::bigint as min_ty,
                floor(
                    (
                        1 - ln(
                            tan(radians(ST_YMin(ST_Envelope(geometry))))
                            + 1 / cos(radians(ST_YMin(ST_Envelope(geometry))))
                        ) / pi()
                    ) / 2 * $n
                )::bigint as max_ty
            from read_parquet($input_parquet)
        )
        select tx, ty, feature_id, tags, ST_AsWKB(geometry)
        from features,
             unnest(range(min_tx, max_tx + 1)) as t(tx),
             unnest(range(min_ty, max_ty + 1)) as u(ty)
        where ST_Intersects(
            geometry,
            ST_transform(
                ST_TileEnvelope($zoom_level, tx::integer, ty::integer),
                'EPSG:3857',
                'EPSG:4326',
                xy := true
            )
        )
        """,
        {
            "input_parquet": str(input_parquet),
            "n": 2**zoom,
            "zoom_level": zoom,
        },
    ).fetchall()
    return group_features_by_tile(rows)


def parquet_to_tiles(
    input_parquet: Path,
    target_folder: Path,
    target_folder_raw: Path | None,
    borders_shape: shapely.Geometry | None = None,
    traffic: bool = True,
    report_dir: Path | None = None,
    report_polygon: BaseGeometry | None = None,
    cache_dir: Path = Path("cache"),
    use_cache: bool = True,
) -> None:
    duckdb.load_extension("spatial")
    zoom_level = TILE_ZOOM
    # every building gets a color, roof shape and roof color: the real tag where
    # it has one, otherwise a sample from the dataset's own distribution
    distributions = building_distributions(input_parquet)
    level_report(input_parquet)
    bb = duckdb.execute(
        """
        with ext as (
            select ST_Extent_Agg(geometry) as bb
            from read_parquet($input_path)
        )
        select
            ST_XMax(bb) as maxlon,
            ST_XMin(bb) as minlon,
            ST_YMax(bb) as maxlat,
            ST_YMin(bb) as minlat
        from ext;
    """,
        {"input_path": str(input_parquet)},
    )
    (maxlon, minlon, maxlat, minlat) = bb.fetchall()[0]
    logger.info(f"Extent of the parquet file: {(maxlon, minlon, maxlat, minlat)}")
    if borders_shape is not None:
        logger.info("Generating bounding box from provided border")
        (minlon, minlat, maxlon, maxlat) = shapely.bounds(borders_shape)
    logger.info(f"Coordinate extent: {(maxlon, minlon, maxlat, minlat)}")
    # Y is swapped because it uses google (computer graphics) convention
    min_x, max_y = coord_to_tile(minlon, minlat, zoom_level)
    max_x, min_y = coord_to_tile(maxlon, maxlat, zoom_level)
    logger.info(f"extent: {[min_x, min_y, max_x, max_y]}")
    traffic_by_tile: dict[tuple[int, int], list[dict]] = {}
    if traffic:
        # traffic is global: one graph per fleet over the whole network, loops
        # split per tile at the end (see tilegen/traffic.py)
        logger.info("Building global traffic loops")
        ways_by_kind = {
            "car": load_ways(input_parquet, "highway", DRIVABLE_HIGHWAYS),
            "train": load_ways(input_parquet, "railway", RAILWAYS),
        }
        configs = {"car": CAR_CONFIG, "train": TRAIN_CONFIG}
        crossing_points = load_crossing_points(input_parquet)
        logger.info(f"{len(crossing_points)} crossing points (signals and crossings)")
        fleets = load_or_build_fleets(ways_by_kind, configs, cache_dir, use_cache)
        for fleet_type, loops in fleets.items():
            logger.info(f"for {fleet_type=} got {len(loops)} loops")
        traffic_by_tile = fleets_to_tiles(fleets, zoom_level)
        logger.info(
            "traffic: %s -> %d tiles with loops",
            {kind: len(ways) for kind, ways in ways_by_kind.items()},
            len(traffic_by_tile),
        )
        if report_dir is not None:
            write_loop_report(fleets, report_dir, report_polygon, crossing_points)
    # one scan groups every feature into the tiles it intersects, instead of a
    # full-parquet query per tile (the grid is mostly empty, and even an empty
    # query costs a full scan)
    features_by_tile = parquet_features_by_tile(input_parquet, zoom_level)
    logger.info(f"features fall in {len(features_by_tile)} tiles")
    # a tile that holds traffic but no OSM feature still gets a file
    for x, y in sorted(set(features_by_tile) | set(traffic_by_tile)):
        logger.info(f"Generating tile {x}/{y}")
        target_path = target_folder / str(x)
        target_path.mkdir(parents=True, exist_ok=True)
        target_path_raw = None
        if target_folder_raw is not None:
            target_path_raw = target_folder_raw / str(x)
            target_path_raw.mkdir(parents=True, exist_ok=True)
        features, raw_features = tile_to_geojson(
            features_by_tile.get((x, y), []), x, y, zoom_level, distributions
        )
        traffic_loops = traffic_by_tile.get((x, y))
        # compact JSON (indent=2 put every coordinate on its own line and
        # dominated the payload) and no files for empty tiles
        if features or traffic_loops:
            document: dict = {"type": "FeatureCollection", "features": features}
            if traffic_loops:
                document["traffic"] = traffic_loops
            (target_path / f"{y}.json").write_text(
                json.dumps(
                    document,
                    separators=(",", ":"),
                    ensure_ascii=False,
                )
            )
        if target_path_raw is not None and raw_features:
            (target_path_raw / f"{y}.json").write_text(
                json.dumps(
                    {"type": "FeatureCollection", "features": raw_features},
                    separators=(",", ":"),
                    ensure_ascii=False,
                )
            )


@click.command()
@click.argument(
    "input_pbf", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--polygon-filter", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--output",
    type=click.Path(file_okay=False, path_type=Path),
    default=Path("tiles"),
    show_default=True,
    help="Directory for render-ready tiles ({x}/{y}.json).",
)
@click.option(
    "--raw-output",
    type=click.Path(file_okay=False, path_type=Path),
    default=Path("raw_tiles"),
    show_default=True,
    help="Directory for raw-tag tiles (all OSM tags).",
)
@click.option(
    "--raw/--no-raw",
    default=True,
    help="Also write the raw-tag tiles (large).",
)
@click.option(
    "--traffic/--no-traffic",
    default=True,
    help="Precompute vehicle routes (loops) and write them into the tiles.",
)
@click.option(
    "--report/--no-report",
    default=True,
    help="Write the loop report (report/loops.md and report/loops.geojson).",
)
@click.option(
    "--report-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=Path("report"),
    show_default=True,
    help="Directory for the loop report.",
)
@click.option(
    "--report-polygon",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    default=None,
    help=(
        "Only put loops intersecting this polygon in the report GeoJSON. "
        f"Defaults to {DEFAULT_REPORT_POLYGON} when that file exists."
    ),
)
@click.option(
    "--cache/--no-cache",
    default=True,
    help=(
        "Reuse precomputed traffic loops cached by input hash. The loop build "
        "is one of the slowest steps, so recompute only when the inputs change."
    ),
)
@click.option(
    "--cache-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=Path("cache"),
    show_default=True,
    help="Directory for the traffic loop cache (only used with --traffic).",
)
def main(
    input_pbf: Path,
    polygon_filter: Path | None,
    output: Path,
    raw_output: Path,
    raw: bool,
    traffic: bool,
    report: bool,
    report_dir: Path,
    report_polygon: Path | None,
    cache: bool,
    cache_dir: Path,
) -> None:
    logger.info(f"Processing {input_pbf}")
    # Note: you can reduce the file size using a border geojson:
    # osmium extract -p borders.geojson {input_pbf} -o extract.osm.pbf
    # also quackosm can produce a parquet file applying a similar filter
    borders_shape = None
    if polygon_filter is not None:
        borders_shape = shapely.from_geojson(polygon_filter.read_text())
    report_shape = None
    if report and traffic:
        polygon_path = report_polygon
        if polygon_path is None and DEFAULT_REPORT_POLYGON.exists():
            polygon_path = DEFAULT_REPORT_POLYGON
            logger.info(f"Using {polygon_path} to clip the report GeoJSON")
        if polygon_path is not None:
            report_shape = shapely.from_geojson(polygon_path.read_text())
    gpq_path = pbf_to_parquet(input_pbf, borders_shape=borders_shape)
    print(f"Extracted: {gpq_path}")
    parquet_to_tiles(
        gpq_path,
        output,
        raw_output if raw else None,
        borders_shape=borders_shape,
        traffic=traffic,
        report_dir=report_dir if report and traffic else None,
        report_polygon=report_shape,
        cache_dir=cache_dir,
        use_cache=cache,
    )


if __name__ == "__main__":
    main()
