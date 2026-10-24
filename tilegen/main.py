"""Command-line entry point for the tile generator.

The heavy lifting lives in ``features.py`` (pure builders), ``loaders.py``
(parquet I/O), and ``pipeline.py`` (tile assembly); this module only selects
inputs and invokes the pipeline.
"""

import logging
from pathlib import Path

import click
import quackosm as qosm
import shapely
from shapely.geometry.base import BaseGeometry

from city import CityError
from features import (  # noqa: F401 - re-exported for the existing API/tests
    _LEVEL_RE,
    _METERS_PER_DEGREE,
    AEROWAY_AREA_KINDS,
    AEROWAY_LINE_KINDS,
    COMPASS,
    CONIFER_GENERA,
    DEFAULT_AEROWAY_WIDTH,
    FENCE_BARRIERS,
    FURNITURE_KINDS,
    GATE_BARRIERS,
    GLASS_MATERIAL_TAGS,
    GREEN_DENSE_LANDUSE,
    GREEN_DENSE_LEISURE,
    GREEN_DENSE_NATURAL,
    GREEN_GRASS_LANDUSE,
    GREEN_GRASS_LEISURE,
    GREEN_GRASS_NATURAL,
    MIN_CEMETERY_AREA,
    MIN_FENCE_LENGTH,
    MIN_GREEN_AREA,
    PARK_PATH_EXCLUDED_FOOTWAY,
    PARK_PATH_HIGHWAYS,
    PORTAL_CLASSES,
    POWER_LINE_KINDS,
    RAIL_KINDS,
    ROAD_PRIORITY,
    ROAD_WIDTHS,
    TERRACE_AMENITIES,
    TUNNEL_SKIP,
    WALL_BARRIERS,
    WATER_LANDUSE,
    WATER_NATURAL,
    WATERWAY_KINDS,
    RoadData,
    _flatten,
    approach_bearings,
    area_square_meters,
    bench_direction,
    building_base,
    building_top,
    crossing_is_marked,
    fence_lines,
    furniture_kind,
    green_kind,
    is_bridge,
    is_cemetery,
    is_construction,
    is_glass,
    is_green,
    is_monument,
    is_park_path,
    is_playground,
    is_power_line,
    is_rail,
    is_rail_platform,
    is_terrace,
    is_tunnel,
    is_water,
    line_bearing,
    monument_kind,
    park_path_kind,
    parse_lane_count,
    parse_length,
    parse_level,
    portal_angle,
    power_wire_height,
    road_width,
    terrace_place,
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
    to_monument,
    to_park_path,
    to_platform,
    to_playground,
    to_power_line,
    to_power_tower,
    to_rail,
    to_road_marking,
    to_stop_point,
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
    tree_type_size,
    tunnel_portals,
    vertical_level,
    water_kind,
    way_bearing,
)
from geo import TILE_ZOOM, coord_to_tile, tile_lonlat_bounds  # noqa: F401
from loaders import (  # noqa: F401 - re-exported for the existing API/tests
    ROOFTOP_KINDS,
    _in_list,
    crossing_points_from_rows,
    load_cemetery_areas,
    load_crossing_points,
    load_footway_sidewalks,
    load_gate_bearings,
    load_parking_ways,
    load_road_data,
    load_rooftop_accessories,
    load_ways,
    outside_cemeteries,
    parking_rows_by_tile,
    rooftop_feature,
    rooftop_kind,
    sidewalk_polygons_by_tile,
    terrace_positions_from_parquet,
)
from parking import (  # noqa: F401 - ParkingRow/ParkingWay are re-exported for tests
    ParkingRow,
    ParkingWay,
    parking_rows,
)
from pipeline import (  # noqa: F401 - re-exported for the existing API/tests
    WATER_SQL,
    _vertical_counts,
    building_distributions,
    group_features_by_tile,
    level_report,
    load_or_build_fleets,
    parquet_features_by_tile,
    parquet_to_tiles,
    tag_distribution,
    tile_to_geojson,
    write_loop_report,
)
from sidewalks import SidewalkLine, sidewalk_centerlines  # noqa: F401
from traffic import (
    road_oneway,  # noqa: F401 - re-exported for tests
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
DEFAULT_CITY_DIR = Path(__file__).resolve().parent.parent / "cities" / "milano"


def pbf_to_parquet(input_pbf: Path, borders_shape: BaseGeometry | None = None) -> Path:
    """Convert the input PBF to the parquet cache used by the pipeline."""
    gpq_path = qosm.convert_pbf_to_parquet(input_pbf, geometry_filter=borders_shape)
    logger.info(f"Extracted: {gpq_path}")
    return gpq_path


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
    "--parking/--no-parking",
    default=True,
    help="Place static parked cars along the roads and write them into the tiles.",
)
@click.option(
    "--lamps/--no-lamps",
    default=True,
    help="Place street lamps along the roads for the night glow.",
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
    "--city-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=DEFAULT_CITY_DIR,
    show_default=False,
    help=(
        "City profile directory (city.json, buildings.json, vehicles.json); "
        "defaults to cities/milano. Missing files keep the Milan defaults."
    ),
)
@click.option(
    "--gtfs",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    default=None,
    help=(
        "Optional GTFS zip. Its shapes become the bus and tram paths; without "
        "it the OSM rail fleet and the current traffic logic are used."
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
    parking: bool,
    lamps: bool,
    report: bool,
    report_dir: Path,
    report_polygon: Path | None,
    city_dir: Path | None,
    gtfs: Path | None,
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
    try:
        parquet_to_tiles(
            gpq_path,
            output,
            raw_output if raw else None,
            borders_shape=borders_shape,
            traffic=traffic,
            parking=parking,
            lamps=lamps,
            report_dir=report_dir if report and traffic else None,
            report_polygon=report_shape,
            cache_dir=cache_dir,
            use_cache=cache,
            gtfs_path=gtfs,
            city_dir=city_dir,
        )
    except CityError as error:
        raise click.ClickException(str(error)) from error


if __name__ == "__main__":
    main()
