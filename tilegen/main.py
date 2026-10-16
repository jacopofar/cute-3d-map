import json
import logging
import zlib
from pathlib import Path

import click
import duckdb
import quackosm as qosm
import shapely
from geo import TILE_ZOOM, coord_to_tile
from shapely.geometry import LineString, MultiLineString
from shapely.geometry.base import BaseGeometry
from traffic import (
    CAR_CONFIG,
    DRIVABLE_HIGHWAYS,
    RAILWAYS,
    TRAIN_CONFIG,
    Loop,
    Way,
    build_fleets,
    fleets_to_tiles,
    loop_coords,
    loop_report,
    loops_to_geojson,
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


def to_building(feature_id, tags, s) -> dict | None:
    if s.geom_type == "Point":
        logger.warning(f"Point building?? {feature_id}")
        return None
    if s.geom_type not in ("Polygon", "MultiPolygon"):
        # don't abort the whole tile run over one weird feature
        logger.warning(f"non-polygon building?? {feature_id} ({s.geom_type})")
        return None
    color = tags.get("building:colour")
    height = parse_length(tags.get("height"))
    if height is None and "building:levels" in tags:
        levels = parse_length(tags["building:levels"])
        if levels is not None:
            height = levels * 3

    properties = {
        "cmtype": "building",
        "color": color,
        "height": height,
        "name": tags.get("name"),
        "street": tags.get("addr:street"),
        "housenumber": tags.get("addr:housenumber"),
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


def tile_to_geojson(data, tile_x: int, tile_y: int, zoom: int) -> tuple[list, list]:
    """Build the render features (buildings, trees) and the raw-tag features.

    The road and rail network is deliberately not emitted: the vehicle routes
    are precomputed wholesale in traffic.py (from the parquet), so the frontend
    never needs the network lines.
    """
    ret = []
    ret_raw = []
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
        if "building" in tags:
            ret.append(to_building(feature_id, tags, s))
        elif tags.get("natural") == "tree":
            ret.append(to_tree(feature_id, tags, s))
        elif tags.get("natural") == "tree_row":
            ret.append(to_tree_row(feature_id, tags, s))

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
        for part in parts:
            if isinstance(part, LineString):
                ways.append(
                    Way(
                        coords=[(c[0], c[1]) for c in part.coords],
                        oneway=oneway,
                        highway=value,
                    )
                )
    return ways


def write_loop_report(
    fleets: dict[str, list[Loop]],
    report_dir: Path,
    polygon: BaseGeometry | None,
) -> None:
    """Write the loop-size report (`loops.md`) and the troubleshooting GeoJSON
    (`loops.geojson`). When `polygon` is given, the GeoJSON keeps only loops
    that intersect it (the comune di Milano by default)."""
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "loops.md").write_text(loop_report(fleets))
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
    (report_dir / "loops.geojson").write_text(
        json.dumps(
            {"type": "FeatureCollection", "features": features},
            separators=(",", ":"),
            ensure_ascii=False,
        )
    )
    logger.info(f"loop report: {len(features)} loops written to {report_dir}")


def parquet_to_tiles(
    input_parquet: Path,
    target_folder: Path,
    target_folder_raw: Path | None,
    borders_shape: shapely.Geometry | None = None,
    traffic: bool = True,
    report_dir: Path | None = None,
    report_polygon: BaseGeometry | None = None,
) -> None:
    duckdb.load_extension("spatial")
    zoom_level = TILE_ZOOM
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
        fleets = build_fleets(ways_by_kind, configs)
        traffic_by_tile = fleets_to_tiles(fleets, zoom_level)
        logger.info(
            "traffic: %s -> %d tiles with loops",
            {kind: len(ways) for kind, ways in ways_by_kind.items()},
            len(traffic_by_tile),
        )
        if report_dir is not None:
            write_loop_report(fleets, report_dir, report_polygon)
    for x in range(min_x, max_x + 1):
        for y in range(min_y, max_y + 1):
            logger.info(f"Generating tile {x}/{y}")
            target_path = target_folder / str(x)
            target_path.mkdir(parents=True, exist_ok=True)
            target_path_raw = None
            if target_folder_raw is not None:
                target_path_raw = target_folder_raw / str(x)
                target_path_raw.mkdir(parents=True, exist_ok=True)
            tile_data = duckdb.execute(
                """
                select
                        feature_id,
                        tags,
                        ST_AsWKB(geometry)
                    from read_parquet($input_parquet)
                    where ST_Intersects(
                        geometry,
                        ST_transform(
                            ST_TileEnvelope($zoom_level, $x, $y),
                            'EPSG:3857',
                            'EPSG:4326',
                            xy := true
                        )
                    )
                """,
                {
                    "input_parquet": str(input_parquet),
                    "zoom_level": zoom_level,
                    "x": x,
                    "y": y,
                },
            )
            features, raw_features = tile_to_geojson(
                tile_data.fetchall(), x, y, zoom_level
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
    )


if __name__ == "__main__":
    main()
