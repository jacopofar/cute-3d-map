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

def coord_to_tile(lon: float, lat: float, zoom: float) -> tuple[int, int]:
    """From EPSG:4326 to web mercator tiles using the """
    # from https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames
    return (
        int((lon + 180) / 360 * (2 ** zoom)),
        # int((2 ** zoom) - ((1-math.log(math.tan(lat * math.pi / 180) + 1 / math.cos(lat * math.pi / 180))/math.pi)/ 2 * (2 ** zoom))),
        int(((1-math.log(math.tan(lat * math.pi / 180) + 1 / math.cos(lat * math.pi / 180))/math.pi)/ 2 * (2 ** zoom))),
    )

def pbf_to_parquet(input_pbf: Path, borders_shape: BaseGeometry|None = None) -> Path:
    gpq_path = qosm.convert_pbf_to_parquet(input_pbf, geometry_filter=borders_shape)
    logger.info(f"Extracted: {gpq_path}")
    return gpq_path

def to_building(feature_id, tags, s) -> dict|None:
    if s.geom_type == 'Point':
        logger.warning(f"Point building?? {feature_id}")
        return None
    if s.geom_type not in ('Polygon', 'MultiPolygon'):
        raise ValueError(f"Cannot handle building of type {s.geom_type}")
    color = tags.get("building:colour")
    height = tags.get("height")
    if height is None and "building:levels" in tags:
        try:
            height = float(tags["building:levels"]) * 3
        except ValueError:
            logger.exception(f"Error in handling feature {feature_id} having tags {tags}")
            return None

    properties = dict(cmtype='building', color=color, height=height)
    return dict(
        type='feature',
        id=feature_id,
        geometry=json.loads(shapely.to_geojson(s)),
        properties={k: v for k, v in properties.items() if v is not None},
    )

def to_tree(feature_id, tags, s) -> dict|None:
    if s.geom_type != 'Point':
        logger.warning(f"non-point tree?? {feature_id}")
        return None
    properties = dict(cmtype='tree')
    return dict(
        type='feature',
        id=feature_id,
        geometry=json.loads(shapely.to_geojson(s)),
        properties={k: v for k, v in properties.items() if v is not None},
    )

def to_tree_row(feature_id, tags, s) -> dict|None:
    if s.geom_type != 'LineString':
        logger.warning(f"non-line tree_row?? {feature_id}")
        return None
    properties = dict(cmtype='tree_row')
    return dict(
        type='feature',
        id=feature_id,
        geometry=json.loads(shapely.to_geojson(s)),
        properties={k: v for k, v in properties.items() if v is not None},
    )

def tile_to_geojson(data) -> tuple[list, list]:
    ret = []
    ret_raw = []
    for feature_id, tags, geometry in data:
        s = shapely.from_wkb(geometry)
        ret_raw.append(dict(
            type='feature',
            id=feature_id,
            geometry=json.loads(shapely.to_geojson(s)),
            properties=tags,
        ))
        if 'building' in tags:
            c = to_building(feature_id, tags, s)
            ret.append(c)
        elif 'natural' in tags and tags['natural'] == 'tree':
            c = to_tree(feature_id, tags, s)
            ret.append(c)
        elif 'natural' in tags and tags['natural'] == 'tree_row':
            c = to_tree_row(feature_id, tags, s)
            ret.append(c)
            continue

    return [r for r in ret if r is not None], ret_raw


def parquet_to_tiles(input_parquet: Path, target_folder: Path, borders_shape: shapely.Geometry|None = None) -> None:
    duckdb.load_extension('spatial')
    zoom_level = 15
    bb = duckdb.execute("""
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
    """, dict(input_path=str(input_parquet)))
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
    for x in range(min_x, max_x):
        for y in range(min_y, max_y):
            logger.info(f"Generating tile {x}/{y}")
            target_path = (target_folder / str(x))
            target_path.mkdir(parents=True, exist_ok=True)
            target_path_raw = (target_folder / 'raw' / str(x))
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
                dict(
                    input_parquet=str(input_parquet),
                    zoom_level=zoom_level,
                    x=x,
                    y=y,
                )
            )
            features, raw_features = tile_to_geojson(tile_data.fetchall())
            with open(target_path / f"{y}.json", "w") as fw:
                fw.write(
                    json.dumps(
                        dict(
                            type="FeatureCollection",
                            features=features,
                        ),
                        indent=2,
                    )
                )
            with open(target_path_raw / f"{y}.json", "w") as fw:
                fw.write(
                    json.dumps(
                        dict(
                            type="FeatureCollection",
                            features=raw_features,
                        ),
                        indent=2,
                    )
                )


@click.command()
@click.argument("input_pbf", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--polygon-filter", type=click.Path(exists=True, dir_okay=False, path_type=Path))
def main(input_pbf: Path, polygon_filter: Path|None) -> None:
    logging.info(f"Processing {input_pbf}")
    # Note: you can reduce the file size using a border geojson:
    # osmium extract -p borders.geojson {input_pbf} -o extract.osm.pbf
    # also quackosm can produce a parquet file applying a similar filter
    borders_shape = None
    if polygon_filter is not None:
        borders_shape = shapely.from_geojson(polygon_filter.read_text())
    gpq_path = pbf_to_parquet(input_pbf, borders_shape=borders_shape)
    print(f"Extracted: {gpq_path}")
    parquet_to_tiles(gpq_path, Path("tiles"), borders_shape=borders_shape)


if __name__ == "__main__":
    main()
