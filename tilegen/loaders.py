"""Parquet loaders and per-tile authoring helpers.

These functions read OSM-derived parquet rows and turn them into the plain
inputs the pure feature builders and traffic graph expect. They are the I/O
boundary between DuckDB and ``features.py``; keeping them out of ``main.py``
leaves the CLI and tile pipeline readable.
"""

import json
import logging
import math
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import duckdb
import shapely
from shapely.geometry import LineString, MultiLineString, Point
from shapely.geometry.base import BaseGeometry
from shapely.prepared import prep

from features import (
    ROAD_PRIORITY,
    ROAD_WIDTHS,
    TERRACE_AMENITIES,
    RoadData,
    building_base,
    building_top,
    parse_lane_count,
    parse_length,
    road_width,
    runs_underground,
    terrace_place,
    way_bearing,
)
from geo import TILE_ZOOM, coord_to_tile, tile_lonlat_bounds
from parking import (
    DEFAULT_HALF_WIDTH,
    PARKING_HIGHWAYS,
    ROAD_HALF_WIDTH,
    ParkingRow,
    ParkingWay,
    sidewalk_side,
)
from sidewalks import SidewalkLine
from traffic import (
    DRIVABLE_HIGHWAYS,
    STOP_KINDS,
    CrossingPoint,
    Way,
    parse_maxspeed,
    road_oneway,
)

logger = logging.getLogger(__name__)


def _in_list(values) -> str:
    return "(" + ", ".join(f"'{value}'" for value in sorted(values)) + ")"


def terrace_positions_from_parquet(
    input_parquet: Path,
) -> dict[str, tuple[float, float]]:
    """Sidewalk positions for the outdoor terraces: nearest road point plus a
    short step toward the cafe. One STRtree over the road lines, so the cost is
    paid once per generation."""
    terraces = duckdb.execute(
        f"""
        select feature_id, tags, ST_AsWKB(geometry)
        from read_parquet($input_path)
        where tags['outdoor_seating'] is not null
          and tags['outdoor_seating'] != 'no'
          and tags['amenity'] in {_in_list(TERRACE_AMENITIES)}
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    road_rows = duckdb.execute(
        """
        select ST_AsWKB(geometry)
        from read_parquet($input_path)
        where tags['highway'] is not null
          and tags['highway'] not in ('motorway', 'motorway_link', 'trunk', 'trunk_link')
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    building_rows = duckdb.execute(
        """
        select ST_AsWKB(geometry)
        from read_parquet($input_path)
        where tags['building'] is not null
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    buildings = []
    for (wkb,) in building_rows:
        geometry = shapely.from_wkb(wkb)
        if geometry.geom_type in ("Polygon", "MultiPolygon"):
            buildings.append(geometry)
    building_tree = shapely.STRtree(buildings)
    lines = []
    for (wkb,) in road_rows:
        geometry = shapely.from_wkb(wkb)
        parts = geometry.geoms if isinstance(geometry, MultiLineString) else [geometry]
        lines.extend(part for part in parts if isinstance(part, LineString))
    if not lines:
        return {}
    tree = shapely.STRtree(lines)
    positions: dict[str, tuple[float, float]] = {}
    for feature_id, tags, wkb in terraces:
        geometry = shapely.from_wkb(wkb)
        if geometry.geom_type == "Point":
            point = geometry
        elif geometry.geom_type == "LineString":
            point = geometry.interpolate(0.5, normalized=True)
        elif geometry.geom_type in ("Polygon", "MultiPolygon"):
            point = geometry.centroid
        else:
            continue
        nearest = tree.query_nearest(point)
        if len(nearest) == 0:
            continue
        placed = terrace_place(
            point,
            lines[int(nearest[0])],
            building_tree,
            buildings,
        )
        positions[str(feature_id)] = (placed.x, placed.y)
    logger.info(
        "terraces: %d cafe points moved to the nearest sidewalk", len(positions)
    )
    return positions


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


def load_parking_ways(input_parquet: Path) -> list[ParkingWay]:
    """Read the parking-eligible highway ways once, with their id and roundabout
    tag (which `load_ways` does not keep). Like the traffic graph, parking is
    placed on the whole ways and only then assigned to tiles."""
    rows = duckdb.execute(
        """
        select feature_id, tags, ST_AsWKB(geometry)
        from read_parquet($input_path)
        where tags['highway'] is not null
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    ways: list[ParkingWay] = []
    for feature_id, tags, wkb in rows:
        value = tags.get("highway")
        if value not in PARKING_HIGHWAYS:
            continue
        roundabout = tags.get("junction") in ("roundabout", "circular")
        sidewalk_tagged = any(
            tags.get(key) for key in ("sidewalk", "sidewalk:left", "sidewalk:right")
        )
        make_sidewalk = value != "service" or bool(sidewalk_tagged)
        geometry = shapely.from_wkb(wkb)
        parts = geometry.geoms if isinstance(geometry, MultiLineString) else [geometry]
        for part in parts:
            if isinstance(part, LineString):
                ways.append(
                    ParkingWay(
                        id=str(feature_id),
                        coords=[(c[0], c[1]) for c in part.coords],
                        highway=value,
                        roundabout=roundabout,
                        sidewalk_left=make_sidewalk and sidewalk_side(tags, "left"),
                        sidewalk_right=make_sidewalk and sidewalk_side(tags, "right"),
                        sidewalk_width_left=parse_length(
                            tags.get("sidewalk:left:width")
                            or tags.get("sidewalk:width")
                        )
                        or (1.5 if value == "service" else 2.0),
                        sidewalk_width_right=parse_length(
                            tags.get("sidewalk:right:width")
                            or tags.get("sidewalk:width")
                        )
                        or (1.5 if value == "service" else 2.0),
                        width=road_width(tags),
                    )
                )
    return ways


def load_track_lines(input_parquet: Path) -> list[LineString]:
    """Tram and surface-rail centrelines, for the parking author.

    Tunnels are left out: a tram under the street does not put rails in the
    kerb lane, so it must not cost the street its parking.
    """
    rows = duckdb.execute(
        """
        select ST_AsWKB(geometry)
        from read_parquet($input_path)
        where tags['railway'] in ('rail', 'tram')
          and (tags['tunnel'] is null or tags['tunnel'] = 'no')
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    lines: list[LineString] = []
    for (wkb,) in rows:
        geometry = shapely.from_wkb(wkb)
        parts = geometry.geoms if isinstance(geometry, MultiLineString) else [geometry]
        for part in parts:
            if isinstance(part, LineString):
                lines.append(part)
    return lines


# the rail networks a tram shape can follow when it is snapped back onto OSM
RAIL_LINES = frozenset({"rail", "tram", "light_rail", "narrow_gauge"})


@dataclass
class RouteNetwork:
    """A vehicle network for snapping: the ways, their underground flags, and
    one spatial index. The index is the point: a shape is snapped per segment,
    so rebuilding it per call would be quadratic."""

    lines: list[LineString]
    underground: list[bool]
    tree: shapely.STRtree


def route_network(lines: list[tuple[LineString, bool]]) -> RouteNetwork:
    """Index a list of (line, underground) pairs for `snap_underground`."""
    return RouteNetwork(
        lines=[line for line, _ in lines],
        underground=[flag for _, flag in lines],
        tree=shapely.STRtree([line for line, _ in lines]),
    )


def load_route_lines(input_parquet: Path) -> dict[str, RouteNetwork]:
    """Every way a vehicle can run along, with its underground flag, indexed.

    Grouped by network ("rail" for trains and trams, "road" for cars and buses)
    so a tram shape cannot snap to a road tunnel that happens to run beside it."""
    rows = duckdb.execute(
        """
        select tags, ST_AsWKB(geometry)
        from read_parquet($input_path)
        where tags['railway'] is not null or tags['highway'] is not null
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    pairs: dict[str, list[tuple[LineString, bool]]] = {"rail": [], "road": []}
    for tags, wkb in rows:
        railway = tags.get("railway")
        highway = tags.get("highway")
        if railway in RAIL_LINES:
            network = "rail"
        elif highway in DRIVABLE_HIGHWAYS:
            network = "road"
        else:
            continue
        geometry = shapely.from_wkb(wkb)
        parts = geometry.geoms if isinstance(geometry, MultiLineString) else [geometry]
        underground = runs_underground(tags)
        for part in parts:
            if isinstance(part, LineString):
                pairs[network].append((part, underground))
    return {name: route_network(lines) for name, lines in pairs.items()}


# a shape that snaps further than this from any line of its own network is not
# running on it (a feed stub, a depot access track), so it counts as surface
SNAP_TOLERANCE_M = 60.0


def snap_underground(
    network: RouteNetwork,
    points: list[tuple[float, float]],
    tolerance_m: float = SNAP_TOLERANCE_M,
) -> list[bool]:
    """Whether each point of a route runs under something.

    A loop seg snaps to its own way at zero distance, so this is exact for the
    OSM fleets. A GTFS shape is the feed's own geometry and sits a median of
    ~20 m off the OSM alignment, where a distance-to-tunnel test would miss most
    of a bore; the nearest line of the same network does not care about the
    offset, only that the shape follows it, and hands over that way's flag."""
    if not network.lines or not points:
        return [False] * len(points)
    # degrees are the unit shapely measures in here; 1 degree of latitude is
    # 111.32 km and the tolerance does not need the cos(latitude) correction
    tolerance = tolerance_m / 111_320.0
    flags: list[bool] = []
    for point in points:
        probe = Point(point)
        index = int(network.tree.nearest(probe))
        line = network.lines[index]
        flags.append(
            bool(network.underground[index]) and line.distance(probe) <= tolerance
        )
    return flags


def load_cemetery_areas(input_parquet: Path) -> BaseGeometry | None:
    """All cemetery polygons of the extract as one prepared-able geometry, or
    None when there are none. Used to keep parked cars and lamps out of the
    grave paths."""
    rows = duckdb.execute(
        """
        select ST_AsWKB(geometry)
        from read_parquet($input_path)
        where (tags['landuse'] = 'cemetery' or tags['amenity'] = 'grave_yard')
          and ST_GeometryType(geometry) in ('POLYGON', 'MULTIPOLYGON')
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    polygons = [shapely.from_wkb(wkb) for (wkb,) in rows]
    return shapely.union_all(polygons) if polygons else None


def outside_cemeteries(
    ways: list[ParkingWay], area: BaseGeometry | None
) -> list[ParkingWay]:
    """Drop the parking/lamps of ways whose midpoint is inside a cemetery. The
    service paths inside a cemetery are parking-eligible, and cars on every grave
    path read as a car park; the streets around the walls keep their parking."""
    if area is None or area.is_empty:
        return ways
    prepared = prep(area)
    outside: list[ParkingWay] = []
    for way in ways:
        if prepared.contains(Point(way.coords[len(way.coords) // 2])):
            continue
        outside.append(way)
    return outside


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


def load_footway_sidewalks(input_parquet: Path) -> list[SidewalkLine]:
    """Sidewalks mapped as their own `footway=sidewalk` ways.

    These are already at the sidewalk centre, so they need no road offset; the
    polygon union merges them with the procedural strips where both exist.
    """
    rows = duckdb.execute(
        """
        select feature_id, tags, ST_AsWKB(geometry)
        from read_parquet($input_path)
        where tags['footway'] = 'sidewalk'
          and ST_GeometryType(geometry) = 'LINESTRING'
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    lines: list[SidewalkLine] = []
    for feature_id, tags, wkb in rows:
        width = (
            parse_length(tags.get("width"))
            or parse_length(tags.get("sidewalk:width"))
            or 2.0
        )
        width = min(max(width, 1.0), 4.0)
        geometry = shapely.from_wkb(wkb)
        parts = geometry.geoms if isinstance(geometry, MultiLineString) else [geometry]
        for index, part in enumerate(parts):
            if not isinstance(part, LineString):
                continue
            lines.append(
                SidewalkLine(
                    id=f"{feature_id}:mapped:{index}",
                    coords=[(c[0], c[1]) for c in part.coords],
                    width=width,
                    side=0,
                )
            )
    return lines


ROOFTOP_KINDS = {
    "water_tower": ("water_tower", 8.0, 3.0),
    "chimney": ("chimney", 12.0, 1.4),
    "antenna": ("antenna", 7.0, 0.5),
    "mast": ("antenna", 9.0, 0.5),
}


def rooftop_kind(tags) -> str | None:
    made = tags.get("man_made")
    if made in ROOFTOP_KINDS:
        return ROOFTOP_KINDS[made][0]
    if tags.get("generator:source") == "solar":
        return "solar"
    return None


def rooftop_feature(
    feature_id,
    tags,
    geometry,
    buildings,
    building_tags,
    tree,
) -> dict | None:
    """Build one rooftop accessory, lifted to the building it sits on."""
    kind = rooftop_kind(tags)
    if kind is None:
        return None
    if geometry.geom_type not in ("Point", "Polygon", "MultiPolygon"):
        return None
    point = geometry if geometry.geom_type == "Point" else geometry.centroid
    base = 0.0
    for index in tree.query(point):
        if buildings[index].contains(point):
            btags = building_tags[index]
            # Reuse the building height rules: a part's top is min_height plus
            # its levels, not the levels alone. The old duplicate here ignored
            # min_height and dropped rooftop gear inside the podium.
            base = building_top(btags, building_base(btags)) or 10.0
            break
    _kind, default_height, default_size = ROOFTOP_KINDS.get(
        tags.get("man_made"), (kind, 0.5, 2.0)
    )
    if kind == "solar":
        height = 0.4
        size = min(8.0, max(1.0, math.sqrt(max(0.0, geometry.area)) * 90_000))
    else:
        absolute = parse_length(tags.get("height"))
        height = (
            max(1.0, absolute - base)
            if absolute and absolute > base
            else default_height
        )
        size = parse_length(tags.get("width")) or default_size
    geometry_out = (
        json.loads(shapely.to_geojson(geometry))
        if kind == "solar" and geometry.geom_type in ("Polygon", "MultiPolygon")
        else {"type": "Point", "coordinates": [point.x, point.y]}
    )
    properties = {
        "cmtype": "rooftop",
        "kind": kind,
        "base": round(base, 1),
        "height": round(height, 1),
        "size": round(size, 1),
    }
    if tags.get("name"):
        properties["name"] = tags["name"]
    return {
        "type": "feature",
        "id": str(feature_id),
        "geometry": geometry_out,
        "properties": properties,
    }


def load_rooftop_accessories(
    input_parquet: Path,
) -> tuple[dict[tuple[int, int], list[dict]], set[str]]:
    """Mapped rooftop equipment, placed on the roof of the containing building.

    Also returns the ids of buildings carrying solar panels, so their pitched
    roof can be kept flat and the panels stay visible.
    """
    building_rows = duckdb.execute(
        """
        select feature_id, tags, ST_AsWKB(geometry)
        from read_parquet($input_path)
        where tags['building'] is not null
          and ST_GeometryType(geometry) in ('POLYGON', 'MULTIPOLYGON')
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    building_ids = [feature_id for feature_id, _tags, _wkb in building_rows]
    buildings = [shapely.from_wkb(wkb) for _id, _tags, wkb in building_rows]
    building_tags = [tags for _id, tags, _wkb in building_rows]
    tree = shapely.STRtree(buildings)
    rows = duckdb.execute(
        """
        select feature_id, tags, ST_AsWKB(geometry)
        from read_parquet($input_path)
        where tags['man_made'] in ('water_tower', 'chimney', 'antenna', 'mast')
           or tags['generator:source'] = 'solar'
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    by_tile: dict[tuple[int, int], list[dict]] = defaultdict(list)
    solar_buildings: set[str] = set()
    for feature_id, tags, wkb in rows:
        geometry = shapely.from_wkb(wkb)
        if rooftop_kind(tags) == "solar":
            center = geometry if geometry.geom_type == "Point" else geometry.centroid
            for index in tree.query(center):
                if buildings[index].contains(center):
                    solar_buildings.add(str(building_ids[index]))
                    break
        feature = rooftop_feature(
            feature_id,
            tags,
            geometry,
            buildings,
            building_tags,
            tree,
        )
        if feature is None:
            continue
        point = geometry if geometry.geom_type == "Point" else geometry.centroid
        by_tile[coord_to_tile(point.x, point.y, TILE_ZOOM)].append(feature)
    return dict(by_tile), solar_buildings


def sidewalk_polygons_by_tile(
    lines: list[SidewalkLine], ways: list[ParkingWay], zoom: int
) -> dict[tuple[int, int], list[dict]]:
    """Buffer, union and clip the sidewalk centre lines per tile.

    Buffering the *whole* line before clipping keeps bends and corners smooth.
    The union of all sidewalk strips in a tile is then cut by the union of the
    car-road surfaces, so a sidewalk never runs across a carriageway while two
    strips that meet at a corner stay one continuous slab.
    """
    lines_by_tile: dict[tuple[int, int], list[SidewalkLine]] = defaultdict(list)
    roads_by_tile: dict[tuple[int, int], list[ParkingWay]] = defaultdict(list)
    for line in lines:
        geometry = shapely.LineString(line.coords)
        min_lon, min_lat, max_lon, max_lat = geometry.bounds
        margin = 0.00015
        min_tx, max_ty = coord_to_tile(min_lon - margin, max_lat + margin, zoom)
        max_tx, min_ty = coord_to_tile(max_lon + margin, min_lat - margin, zoom)
        for tx in range(min_tx, max_tx + 1):
            for ty in range(min_ty, max_ty + 1):
                lines_by_tile[(tx, ty)].append(line)
    for way in ways:
        geometry = shapely.LineString(way.coords)
        min_lon, min_lat, max_lon, max_lat = geometry.bounds
        margin = 0.0002
        min_tx, max_ty = coord_to_tile(min_lon - margin, max_lat + margin, zoom)
        max_tx, min_ty = coord_to_tile(max_lon + margin, min_lat - margin, zoom)
        for tx in range(min_tx, max_tx + 1):
            for ty in range(min_ty, max_ty + 1):
                roads_by_tile[(tx, ty)].append(way)

    by_tile: dict[tuple[int, int], list[dict]] = {}
    for (tx, ty), tile_lines in lines_by_tile.items():
        sidewalks = [
            shapely.LineString(line.coords).buffer(
                line.width / 2 / 111_000,
                cap_style="flat",
                join_style="mitre",
                resolution=2,
            )
            for line in tile_lines
        ]
        roads = [
            shapely.LineString(way.coords).buffer(
                (
                    way.width / 2
                    if way.width
                    else ROAD_HALF_WIDTH.get(way.highway, DEFAULT_HALF_WIDTH)
                )
                / 111_000
                + 2.0 / 111_000,
                cap_style="flat",
                join_style="mitre",
                resolution=2,
            )
            for way in roads_by_tile.get((tx, ty), [])
        ]
        union_sidewalks = shapely.union_all(sidewalks)
        union_roads = shapely.union_all(roads) if roads else None
        if union_roads is not None and not union_roads.is_empty:
            clipped = union_sidewalks.difference(union_roads)
        else:
            clipped = union_sidewalks
        box = shapely.box(*tile_lonlat_bounds(tx, ty, zoom))
        clipped = clipped.intersection(box)
        if clipped.is_empty:
            continue
        # close the hairline gaps where strips from two roads meet at a corner
        clipped = clipped.buffer(0.000003, join_style="round").buffer(
            -0.000003, join_style="round"
        )
        clipped = clipped.simplify(0.000002, preserve_topology=True)
        by_tile[(tx, ty)] = [
            {
                "type": "feature",
                "id": f"sidewalk/{tx}/{ty}",
                "geometry": json.loads(shapely.to_geojson(clipped)),
                "properties": {"cmtype": "sidewalk"},
            }
        ]
    return by_tile


def parking_rows_by_tile(
    rows: list[ParkingRow], zoom: int
) -> dict[tuple[int, int], list[dict]]:
    """Clip authored parking rows to the tile that will carry them. The row
    metadata stays intact; only the line is split at tile seams."""
    by_tile: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for row in rows:
        line = shapely.LineString(row.coords)
        min_lon, min_lat, max_lon, max_lat = line.bounds
        min_tx, max_ty = coord_to_tile(min_lon, max_lat, zoom)
        max_tx, min_ty = coord_to_tile(max_lon, min_lat, zoom)
        for tx in range(min_tx, max_tx + 1):
            for ty in range(min_ty, max_ty + 1):
                box = shapely.box(*tile_lonlat_bounds(tx, ty, zoom))
                clipped = line.intersection(box)
                if clipped.is_empty:
                    continue
                for part in shapely.get_parts(clipped):
                    if part.geom_type != "LineString":
                        continue
                    coords = [
                        [round(lon, 7), round(lat, 7)] for lon, lat in part.coords
                    ]
                    if len(coords) < 2:
                        continue
                    by_tile[(tx, ty)].append(
                        {
                            "id": row.id,
                            "coords": coords,
                            "style": row.style,
                            "pitch": round(row.pitch, 2),
                            "side": row.side,
                            "occupancy": row.occupancy,
                        }
                    )
    return dict(by_tile)


def load_gate_bearings(input_parquet: Path) -> dict[int, float]:
    """Match gate nodes to the nearest wall way, for the gate's orientation."""
    rows = duckdb.execute(
        """
        select ST_AsWKB(geometry)
        from read_parquet($input_path)
        where (tags['barrier'] in ('wall', 'retaining_wall', 'city_wall', 'hoarding')
               or tags['wall'] is not null)
          and ST_GeometryType(geometry) = 'LINESTRING'
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    walls = [shapely.from_wkb(wkb) for (wkb,) in rows]
    if not walls:
        return {}
    tree = shapely.STRtree(walls)
    gates = duckdb.execute(
        """
        select feature_id, ST_X(geometry), ST_Y(geometry)
        from read_parquet($input_path)
        where tags['barrier'] in ('gate', 'lift_gate', 'swing_gate', 'wicket_gate', 'sliding_gate')
          and ST_GeometryType(geometry) = 'POINT'
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    bearings: dict[int, float] = {}
    for feature_id, lon, lat in gates:
        point = Point(lon, lat)
        candidates = tree.query(point.buffer(0.00005))
        best_distance = math.inf
        best_line: LineString | None = None
        for index in candidates:
            distance = walls[index].distance(point)
            if distance < best_distance:
                best_distance = distance
                best_line = walls[index]
        if best_line is not None and best_distance <= 0.00005:
            bearings[feature_id] = way_bearing(best_line, point)
    return bearings


def load_road_data(input_parquet: Path) -> dict[int, RoadData]:
    """Match every crossing/stop/signal node to its road way and keep the local
    bearing, width and lane tags. A spatial index over the drivable ways is
    enough: the nodes sit on the way geometry, so the nearest segment is the
    road."""
    classes = ",".join(f"'{name}'" for name in ROAD_WIDTHS)
    rows = duckdb.execute(
        f"""
        select tags, ST_AsWKB(geometry)
        from read_parquet($input_path)
        where tags['highway'] in ({classes})
          and ST_GeometryType(geometry) = 'LINESTRING'
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    ways: list[LineString] = []
    tags_by_way: list[dict] = []
    for tags, wkb in rows:
        ways.append(shapely.from_wkb(wkb))
        tags_by_way.append(tags)
    tree = shapely.STRtree(ways)
    crossings = duckdb.execute(
        """
        select feature_id, ST_X(geometry), ST_Y(geometry)
        from read_parquet($input_path)
        where tags['highway'] in ('crossing', 'traffic_signals', 'stop', 'give_way')
          and ST_GeometryType(geometry) = 'POINT'
        """,
        {"input_path": str(input_parquet)},
    ).fetchall()
    roads: dict[int, RoadData] = {}
    for feature_id, lon, lat in crossings:
        point = Point(lon, lat)
        candidates = tree.query(point.buffer(0.00008))
        best: tuple[tuple[float, int], int] | None = None
        for index in candidates:
            distance = ways[index].distance(point)
            if distance > 0.00004:
                continue
            tags = tags_by_way[index]
            if tags.get("tunnel") in ("yes", "building_passage", "culvert"):
                continue
            if tags.get("bridge") not in (None, "no"):
                continue
            layer = parse_length(tags.get("layer"))
            if layer not in (None, 0):
                continue
            key = (distance, ROAD_PRIORITY.get(tags.get("highway"), 99))
            if best is None or key < best[0]:
                best = (key, index)
        if best is None:
            continue
        line = ways[best[1]]
        tags = tags_by_way[best[1]]
        width = road_width(tags)
        bearing = way_bearing(line, point)
        roads[feature_id] = RoadData(
            bearing=bearing,
            width=width,
            lanes=parse_lane_count(tags, width),
            oneway=tags.get("oneway"),
            turn_lanes=tags.get("turn:lanes"),
            turn_lanes_backward=tags.get("turn:lanes:backward"),
        )
    return roads
