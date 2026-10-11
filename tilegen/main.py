import json
import logging
import math
from pathlib import Path

import click
import duckdb
import quackosm as qosm
import shapely
from shapely.geometry.base import BaseGeometry

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

# Web-Mercator zoom at which tiles are generated. Must match TILE_ZOOM in
# src/geojson_data.ts, since the frontend requests tiles/{x}/{y}.json at that
# zoom.
TILE_ZOOM = 15

# highway values whose ways carry vehicles; used to emit "road" features that
# the frontend drives cars along
DRIVABLE_HIGHWAYS = frozenset(
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
        "unclassified",
        "residential",
        "living_street",
        "service",
        "road",
    }
)


def coord_to_tile(lon: float, lat: float, zoom: float) -> tuple[int, int]:
    """From EPSG:4326 to web mercator tiles using the"""
    # from https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames
    return (
        int((lon + 180) / 360 * (2**zoom)),
        # int((2 ** zoom) - ((1-math.log(math.tan(lat * math.pi / 180) + 1 / math.cos(lat * math.pi / 180))/math.pi)/ 2 * (2 ** zoom))),
        int(
            (
                1
                - math.log(
                    math.tan(lat * math.pi / 180) + 1 / math.cos(lat * math.pi / 180)
                )
                / math.pi
            )
            / 2
            * (2**zoom)
        ),
    )


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

    properties = {"cmtype": "building", "color": color, "height": height}
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def to_tree(feature_id, tags, s) -> dict | None:
    if s.geom_type != "Point":
        logger.warning(f"non-point tree?? {feature_id}")
        return None
    properties = {"cmtype": "tree"}
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
    properties = {"cmtype": "tree_row"}
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def to_road(feature_id, tags, s) -> dict | None:
    if s.geom_type not in ("LineString", "MultiLineString"):
        logger.warning(f"non-line road?? {feature_id} ({s.geom_type})")
        return None
    properties = {"cmtype": "road", "highway": tags.get("highway")}
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def tile_to_geojson(data) -> tuple[list, list]:
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
            c = to_building(feature_id, tags, s)
            ret.append(c)
        elif "natural" in tags and tags["natural"] == "tree":
            c = to_tree(feature_id, tags, s)
            ret.append(c)
        elif "natural" in tags and tags["natural"] == "tree_row":
            c = to_tree_row(feature_id, tags, s)
            ret.append(c)
            continue
        elif tags.get("highway") in DRIVABLE_HIGHWAYS:
            c = to_road(feature_id, tags, s)
            ret.append(c)

    return [r for r in ret if r is not None], ret_raw


def parquet_to_tiles(
    input_parquet: Path,
    target_folder: Path,
    target_folder_raw: Path | None,
    borders_shape: shapely.Geometry | None = None,
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
            features, raw_features = tile_to_geojson(tile_data.fetchall())
            # compact JSON (indent=2 put every coordinate on its own line and
            # dominated the payload) and no files for empty tiles
            if features:
                (target_path / f"{y}.json").write_text(
                    json.dumps(
                        {"type": "FeatureCollection", "features": features},
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
def main(
    input_pbf: Path,
    polygon_filter: Path | None,
    output: Path,
    raw_output: Path,
    raw: bool,
) -> None:
    logger.info(f"Processing {input_pbf}")
    # Note: you can reduce the file size using a border geojson:
    # osmium extract -p borders.geojson {input_pbf} -o extract.osm.pbf
    # also quackosm can produce a parquet file applying a similar filter
    borders_shape = None
    if polygon_filter is not None:
        borders_shape = shapely.from_geojson(polygon_filter.read_text())
    gpq_path = pbf_to_parquet(input_pbf, borders_shape=borders_shape)
    print(f"Extracted: {gpq_path}")
    parquet_to_tiles(
        gpq_path,
        output,
        raw_output if raw else None,
        borders_shape=borders_shape,
    )


if __name__ == "__main__":
    main()
