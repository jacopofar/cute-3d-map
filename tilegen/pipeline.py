"""Tile pipeline: turn loaded OSM rows into per-tile JSON documents.

This module owns the tile-level assembly and serialization. The pure feature
builders are in ``features.py`` and the parquet loaders in ``loaders.py``; the
CLI in ``main.py`` only selects inputs and calls ``parquet_to_tiles``.
"""

import json
import logging
import shutil
from collections import defaultdict
from pathlib import Path
from typing import cast

import duckdb
import shapely
from shapely.geometry.base import BaseGeometry

from city import CityProfile, load_city
from features import (
    AEROWAY_AREA_KINDS,
    AEROWAY_LINE_KINDS,
    FENCE_BARRIERS,
    GATE_BARRIERS,
    PORTAL_CLASSES,
    WALL_BARRIERS,
    WATER_LANDUSE,
    WATER_NATURAL,
    WATERWAY_KINDS,
    RoadData,
    furniture_kind,
    is_bridge,
    is_cemetery,
    is_construction,
    is_green,
    is_lane_road,
    is_monument,
    is_park_path,
    is_playground,
    is_power_line,
    is_rail,
    is_rail_platform,
    is_terrace,
    is_tunnel,
    is_water,
    parse_level,
    to_aeroway,
    to_bench,
    to_bridge,
    to_building,
    to_cemetery,
    to_construction,
    to_crossing,
    to_crosswalk,
    to_fence,
    to_fountain,
    to_furniture,
    to_gate,
    to_green,
    to_lane,
    to_monument,
    to_park_path,
    to_platform,
    to_playground,
    to_power_line,
    to_power_tower,
    to_rail,
    to_road_marking,
    to_terrace,
    to_traffic_signal,
    to_transit_stop,
    to_tree,
    to_tree_row,
    to_tunnel,
    to_wall,
    to_water,
    transit_kind,
    transport_class,
)
from geo import TILE_ZOOM, coord_to_tile, tile_lonlat_bounds
from gtfs import load_gtfs_fleets
from gtfs_routes import write_gtfs_route_report
from impute import IMPUTED_FIELDS, Distribution
from lamps import lamp_spots
from loaders import (
    _in_list,
    load_cemetery_areas,
    load_crossing_points,
    load_footway_sidewalks,
    load_gate_bearings,
    load_parking_ways,
    load_road_data,
    load_rooftop_accessories,
    load_route_lines,
    load_track_lines,
    load_ways,
    outside_cemeteries,
    parking_rows_by_tile,
    sidewalk_polygons_by_tile,
    snap_underground,
    terrace_positions_from_parquet,
)
from parking import parking_rows
from sidewalks import sidewalk_centerlines
from traffic import (
    CAR_CONFIG,
    DRIVABLE_HIGHWAYS,
    RAILWAYS,
    TRAIN_CONFIG,
    CrossingPoint,
    Loop,
    TrafficConfig,
    Way,
    build_fleets,
    fill_hidden,
    fleets_cache_key,
    fleets_from_records,
    fleets_to_records,
    fleets_to_tiles,
    loop_coords,
    loop_report,
    loops_to_geojson,
)

logger = logging.getLogger(__name__)


def _green_union(data) -> shapely.Geometry:
    """Union of the tile's green areas, used to clip park paths."""
    shapes = [
        shapely.from_wkb(geometry)
        for _feature_id, tags, geometry in data
        if is_green(tags)
    ]
    return shapely.union_all(shapes) if shapes else shapely.GeometryCollection()


def _render_feature(
    feature_id,
    tags,
    s: shapely.Geometry,
    tile_box: shapely.Geometry,
    green_union: shapely.Geometry,
    distributions: dict[str, Distribution] | None,
    terrace_positions: dict[str, tuple[float, float]] | None,
    road_data: dict[int, RoadData] | None,
    gate_bearings: dict[int, float] | None,
    solar_buildings: set[str] | None,
    city: CityProfile | None,
) -> list:
    """Dispatch one OSM feature to its render builder(s).

    Order is deliberate: a bridge before a building, a tunnel before water, and
    a building before the generic area handlers. The function returns a list
    because a crossing emits both its data-only point and its zebra geometry.
    """
    if is_bridge(tags):
        # building=bridge is a bridge, not a house
        return [to_bridge(feature_id, tags, s, tile_box)]
    if is_tunnel(tags) and transport_class(tags) in PORTAL_CLASSES:
        # a culverted river keeps its water rendering; only a road/rail tunnel
        # becomes a portal
        return to_tunnel(feature_id, tags, s, tile_box)
    if "building" in tags or "building:part" in tags:
        return [
            to_building(
                feature_id,
                tags,
                s,
                distributions,
                solar_buildings,
                city.building_override(feature_id, tags, cast(BaseGeometry, s))
                if city
                else None,
            )
        ]
    if tags.get("natural") == "tree":
        return [to_tree(feature_id, tags, s)]
    if tags.get("natural") == "tree_row":
        return [to_tree_row(feature_id, tags, s)]
    if tags.get("highway") == "traffic_signals":
        return [
            to_traffic_signal(feature_id, tags, s),
            to_road_marking(feature_id, tags, s, road_data),
        ]
    if tags.get("highway") in ("stop", "give_way"):
        return [to_road_marking(feature_id, tags, s, road_data)]
    if tags.get("highway") == "crossing":
        return [
            to_crossing(feature_id, tags, s),
            to_crosswalk(feature_id, tags, s, road_data),
        ]
    if is_lane_road(tags):
        return [to_lane(feature_id, tags, s, tile_box)]
    if tags.get("amenity") == "bench":
        return [to_bench(feature_id, tags, s)]
    if is_rail_platform(tags):
        return [to_platform(feature_id, tags, s, tile_box)]
    if is_rail(tags):
        return [to_rail(feature_id, tags, s, tile_box)]
    if is_construction(tags):
        return [to_construction(feature_id, tags, s, tile_box)]
    if is_playground(tags):
        return [to_playground(feature_id, tags, s)]
    if is_monument(tags):
        return [to_monument(feature_id, tags, s)]
    if is_terrace(tags):
        return [
            to_terrace(
                feature_id,
                tags,
                s,
                (terrace_positions or {}).get(str(feature_id)),
            )
        ]
    if transit_kind(tags) is not None:
        return [to_transit_stop(feature_id, tags, s)]
    if tags.get("amenity") == "fountain":
        return [to_fountain(feature_id, tags, s)]
    if furniture_kind(tags) is not None:
        return [to_furniture(feature_id, tags, s)]
    if tags.get("power") == "tower":
        return [to_power_tower(feature_id, tags, s)]
    if is_power_line(tags):
        return to_power_line(feature_id, tags, s, tile_box)
    if is_park_path(tags):
        return [to_park_path(feature_id, tags, s, green_union, tile_box)]
    if is_water(tags):
        return [to_water(feature_id, tags, s, tile_box)]
    if is_cemetery(tags):
        return [to_cemetery(feature_id, tags, s, tile_box)]
    if is_green(tags):
        return [to_green(feature_id, tags, s, tile_box)]
    if tags.get("aeroway") in (AEROWAY_LINE_KINDS | AEROWAY_AREA_KINDS):
        return [to_aeroway(feature_id, tags, s)]
    if tags.get("barrier") in GATE_BARRIERS:
        return [to_gate(feature_id, tags, s, gate_bearings)]
    if tags.get("barrier") in WALL_BARRIERS or tags.get("wall"):
        return [to_wall(feature_id, tags, s, tile_box)]
    if tags.get("barrier") in FENCE_BARRIERS:
        return [to_fence(feature_id, tags, s, tile_box)]
    return []


def tile_to_geojson(
    data,
    tile_x: int,
    tile_y: int,
    zoom: int,
    distributions: dict[str, Distribution] | None = None,
    terrace_positions: dict[str, tuple[float, float]] | None = None,
    road_data: dict[int, RoadData] | None = None,
    gate_bearings: dict[int, float] | None = None,
    solar_buildings: set[str] | None = None,
    city: CityProfile | None = None,
) -> tuple[list, list]:
    """Build the render features and the raw-tag features for one tile.

    The road and rail network is deliberately not emitted: vehicle routes are
    precomputed wholesale in ``traffic.py``. Park paths are clipped to the
    tile's green union, so that union is built once here.
    """
    min_lon, min_lat, max_lon, max_lat = tile_lonlat_bounds(tile_x, tile_y, zoom)
    tile_box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    green_union = _green_union(data)
    render: list = []
    raw: list = []
    for feature_id, tags, geometry in data:
        s = shapely.from_wkb(geometry)
        raw.append(
            {
                "type": "feature",
                "id": feature_id,
                "geometry": json.loads(shapely.to_geojson(s)),
                "properties": tags,
            }
        )
        render.extend(
            _render_feature(
                feature_id,
                tags,
                s,
                tile_box,
                green_union,
                distributions,
                terrace_positions,
                road_data,
                gate_bearings,
                solar_buildings,
                city,
            )
        )
    return [feature for feature in render if feature is not None], raw


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


def _tile_extent(
    input_parquet: Path, borders_shape: shapely.Geometry | None
) -> tuple[int, int, int, int]:
    """The tile range covered by the parquet, optionally narrowed by a border."""
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
    # Y is swapped because it uses Google (computer graphics) convention.
    min_x, max_y = coord_to_tile(minlon, minlat, TILE_ZOOM)
    max_x, min_y = coord_to_tile(maxlon, maxlat, TILE_ZOOM)
    logger.info(f"extent: {[min_x, min_y, max_x, max_y]}")
    return min_x, min_y, max_x, max_y


def _traffic_layers(
    input_parquet: Path,
    zoom: int,
    gtfs_path: Path | None,
    cache_dir: Path,
    use_cache: bool,
    report_dir: Path | None,
    report_polygon: BaseGeometry | None,
    city: CityProfile | None,
) -> dict[tuple[int, int], list[dict]]:
    """Build every fleet and split its runs per tile."""
    logger.info("Building global traffic loops")
    # With GTFS, the feed owns the bus/tram paths; keep the OSM train fleet
    # for heavy rail only so trams are not drawn twice.
    railways = frozenset({"rail"}) if gtfs_path else RAILWAYS
    ways_by_kind = {
        "car": load_ways(input_parquet, "highway", DRIVABLE_HIGHWAYS),
        "train": load_ways(input_parquet, "railway", railways),
    }
    configs = {"car": CAR_CONFIG, "train": TRAIN_CONFIG}
    crossing_points = load_crossing_points(input_parquet)
    logger.info(f"{len(crossing_points)} crossing points (signals and crossings)")
    fleets = load_or_build_fleets(ways_by_kind, configs, cache_dir, use_cache)
    if gtfs_path is not None:
        gtfs_fleets = load_gtfs_fleets(gtfs_path, city=city)
        fleets.update(gtfs_fleets)
        logger.info(
            "GTFS paths: %s",
            {kind: len(loops) for kind, loops in gtfs_fleets.items()},
        )
    # every fleet learns where it runs under something by snapping onto the OSM
    # network it follows: exact for a loop edge (it snaps to its own way, at
    # zero distance) and the only way for a GTFS shape, which is feed geometry.
    # Done after the cache, so the cached loops keep their plain shape.
    networks = load_route_lines(input_parquet)
    for kind, loops in fleets.items():
        lines = networks["rail" if kind in ("train", "tram") else "road"]
        for loop in loops:
            fill_hidden(loop, [snap_underground(lines, seg) for seg in loop.segs])
        logger.info(
            "traffic %s: %d loops, %d with an underground stretch",
            kind,
            len(loops),
            sum(1 for loop in loops if loop.hidden),
        )
    for fleet_type, loops in fleets.items():
        logger.info(f"for {fleet_type=} got {len(loops)} loops")
    traffic_by_tile = fleets_to_tiles(fleets, zoom)
    logger.info(
        "traffic: %s -> %d tiles with loops",
        {kind: len(ways) for kind, ways in ways_by_kind.items()},
        len(traffic_by_tile),
    )
    if report_dir is not None:
        write_loop_report(fleets, report_dir, report_polygon, crossing_points)
        if gtfs_path is not None:
            write_gtfs_route_report(gtfs_path, report_dir)
    return traffic_by_tile


def _static_layers(
    input_parquet: Path, zoom: int, parking: bool, lamps: bool
) -> tuple[
    dict[tuple[int, int], list[dict]],
    dict[tuple[int, int], list[dict]],
    dict[tuple[int, int], list[dict]],
    set[str],
    dict[tuple[int, int], list[list[float]]],
]:
    """Build parking, sidewalks, lamps and rooftop gear independently of traffic."""
    parking_by_tile: dict[tuple[int, int], list[dict]] = {}
    sidewalk_by_tile: dict[tuple[int, int], list[dict]] = {}
    rooftop_by_tile: dict[tuple[int, int], list[dict]] = {}
    solar_buildings: set[str] = set()
    lamp_by_tile: dict[tuple[int, int], list[list[float]]] = {}
    # The three layers share the same road source, so it is read once, but each
    # one is built on its own flag: sidewalks used to sit inside the parking/
    # lamps branch, so --no-parking --no-lamps silently dropped a layer that has
    # no flag of its own.
    logger.info("Building sidewalks, parked cars and street lamps")
    parking_ways = load_parking_ways(input_parquet)
    cemetery_area = load_cemetery_areas(input_parquet)
    kept = outside_cemeteries(parking_ways, cemetery_area)
    if len(kept) != len(parking_ways):
        logger.info(
            "parking: dropped %d ways inside cemeteries",
            len(parking_ways) - len(kept),
        )
    parking_ways = kept
    if parking:
        tracks = load_track_lines(input_parquet)
        parking_data = parking_rows(parking_ways, tracks)
        parking_by_tile = parking_rows_by_tile(parking_data, zoom)
        logger.info(
            "parking: %d ways -> %d rows in %d tiles",
            len(parking_ways),
            sum(len(rows) for rows in parking_by_tile.values()),
            len(parking_by_tile),
        )
    sidewalk_data = sidewalk_centerlines(parking_ways)
    mapped_sidewalks = load_footway_sidewalks(input_parquet)
    sidewalk_data.extend(mapped_sidewalks)
    logger.info(
        "sidewalks: %d procedural + %d mapped",
        len(sidewalk_data) - len(mapped_sidewalks),
        len(mapped_sidewalks),
    )
    sidewalk_by_tile = sidewalk_polygons_by_tile(sidewalk_data, parking_ways, zoom)
    logger.info(
        "sidewalks: %d ways -> %d polygons in %d tiles",
        len(parking_ways),
        sum(len(rows) for rows in sidewalk_by_tile.values()),
        len(sidewalk_by_tile),
    )
    if lamps:
        lamp_by_tile = lamp_spots(parking_ways, zoom)
        logger.info(
            "lamps: %d ways -> %d lamps in %d tiles",
            len(parking_ways),
            sum(len(spots) for spots in lamp_by_tile.values()),
            len(lamp_by_tile),
        )
    # Rooftop equipment is independent of the parking/lamps pass.
    rooftop_by_tile, solar_buildings = load_rooftop_accessories(input_parquet)
    logger.info(
        "rooftop accessories: %d tiles, %d solar buildings",
        len(rooftop_by_tile),
        len(solar_buildings),
    )
    return (
        parking_by_tile,
        sidewalk_by_tile,
        rooftop_by_tile,
        solar_buildings,
        lamp_by_tile,
    )


def _write_tile(
    x: int,
    y: int,
    *,
    zoom: int,
    features: list[tuple],
    target_folder: Path,
    target_folder_raw: Path | None,
    distributions: dict[str, Distribution],
    terrace_positions: dict[str, tuple[float, float]],
    road_data: dict[int, RoadData],
    gate_bearings: dict[int, float],
    solar_buildings: set[str],
    sidewalk_here: list[dict] | None,
    rooftop_here: list[dict] | None,
    traffic_loops: list[dict] | None,
    parking_here: list[dict] | None,
    lamps_here: list[list[float]] | None,
    city: CityProfile | None,
) -> None:
    """Render and write one tile document (and its raw twin when requested)."""
    target_path = target_folder / str(x)
    target_path.mkdir(parents=True, exist_ok=True)
    target_path_raw = None
    if target_folder_raw is not None:
        target_path_raw = target_folder_raw / str(x)
        target_path_raw.mkdir(parents=True, exist_ok=True)
    render, raw_features = tile_to_geojson(
        features,
        x,
        y,
        zoom,
        distributions,
        terrace_positions,
        road_data,
        gate_bearings,
        solar_buildings,
        city,
    )
    if sidewalk_here:
        render.extend(sidewalk_here)
    if rooftop_here:
        render.extend(rooftop_here)
    if city is not None and city.directory is not None:
        for feature in render:
            model = feature.get("properties", {}).get("model")
            if not isinstance(model, dict) or "file" not in model:
                continue
            source = city.directory / model.pop("file")
            asset_dir = target_path / f"{y}_assets"
            asset_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, asset_dir / source.name)
            model["asset"] = f"{x}/{y}_assets/{source.name}"
    # Compact JSON (indent=2 put every coordinate on its own line and dominated
    # the payload); empty tiles get no file.
    if render or traffic_loops or parking_here or lamps_here:
        document: dict = {"type": "FeatureCollection", "features": render}
        if traffic_loops:
            document["traffic"] = traffic_loops
        if parking_here:
            document["parking"] = parking_here
        if lamps_here:
            document["lamps"] = lamps_here
        (target_path / f"{y}.json").write_text(
            json.dumps(document, separators=(",", ":"), ensure_ascii=False)
        )
    if target_path_raw is not None and raw_features:
        (target_path_raw / f"{y}.json").write_text(
            json.dumps(
                {"type": "FeatureCollection", "features": raw_features},
                separators=(",", ":"),
                ensure_ascii=False,
            )
        )


def parquet_to_tiles(
    input_parquet: Path,
    target_folder: Path,
    target_folder_raw: Path | None,
    borders_shape: shapely.Geometry | None = None,
    traffic: bool = True,
    parking: bool = True,
    lamps: bool = True,
    report_dir: Path | None = None,
    report_polygon: BaseGeometry | None = None,
    cache_dir: Path = Path("cache"),
    use_cache: bool = True,
    gtfs_path: Path | None = None,
    city_dir: Path | None = None,
) -> None:
    """Build every render tile from one parquet, including optional layers."""
    duckdb.load_extension("spatial")
    zoom = TILE_ZOOM
    city = load_city(city_dir)
    distributions = building_distributions(input_parquet)
    terrace_positions = terrace_positions_from_parquet(input_parquet)
    level_report(input_parquet)
    _tile_extent(input_parquet, borders_shape)
    traffic_by_tile = (
        _traffic_layers(
            input_parquet,
            zoom,
            gtfs_path,
            cache_dir,
            use_cache,
            report_dir,
            report_polygon,
            city,
        )
        if traffic
        else {}
    )
    (
        parking_by_tile,
        sidewalk_by_tile,
        rooftop_by_tile,
        solar_buildings,
        lamp_by_tile,
    ) = _static_layers(input_parquet, zoom, parking, lamps)
    # One scan groups every feature into the tiles it intersects, instead of a
    # full-parquet query per tile.
    features_by_tile = parquet_features_by_tile(input_parquet, zoom)
    logger.info(f"features fall in {len(features_by_tile)} tiles")
    road_data = load_road_data(input_parquet)
    gate_bearings = load_gate_bearings(input_parquet)
    logger.info(
        f"road data for {len(road_data)} crossing/stop nodes, "
        f"{len(gate_bearings)} gates"
    )
    tiles = (
        set(features_by_tile)
        | set(traffic_by_tile)
        | set(parking_by_tile)
        | set(sidewalk_by_tile)
        | set(rooftop_by_tile)
        | set(lamp_by_tile)
    )
    for x, y in sorted(tiles):
        logger.info(f"Generating tile {x}/{y}")
        _write_tile(
            x,
            y,
            zoom=zoom,
            features=features_by_tile.get((x, y), []),
            target_folder=target_folder,
            target_folder_raw=target_folder_raw,
            distributions=distributions,
            terrace_positions=terrace_positions,
            road_data=road_data,
            gate_bearings=gate_bearings,
            solar_buildings=solar_buildings,
            sidewalk_here=sidewalk_by_tile.get((x, y)),
            rooftop_here=rooftop_by_tile.get((x, y)),
            traffic_loops=traffic_by_tile.get((x, y)),
            parking_here=parking_by_tile.get((x, y)),
            lamps_here=lamp_by_tile.get((x, y)),
            city=city,
        )
