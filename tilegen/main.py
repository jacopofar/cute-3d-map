import json
import logging
import math
from pathlib import Path

import click
import duckdb
import quackosm as qosm
import shapely

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

def pbf_to_parquet(input_pbf: Path, borders_shape: shapely.Geometry|None = None) -> Path:
    gpq_path = qosm.convert_pbf_to_parquet(input_pbf, geometry_filter=borders_shape)
    logger.info(f"Extracted: {gpq_path}")
    return gpq_path

def tile_to_geojson(data) -> list:
    ret = []
    for feature_id, tags, geometry in data:
        s = shapely.from_wkb(geometry)
        if 'building' not in tags:
            continue
        if s.geom_type == 'Point':
            logger.warning(f"Point building?? {feature_id}")
            continue
        if s.geom_type not in ('Polygon', 'MultiPolygon'):
            raise ValueError(f"Cannot handle building of type {s.geom_type}")
        feature_obj = dict(
            type='feature',
            id='feature_id',
            geometry=json.loads(shapely.to_geojson(s)),
            properties=tags,
        )
        ret.append(feature_obj)
    return ret


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
            (target_folder / str(x)).mkdir(parents=True, exist_ok=True)
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
            features = tile_to_geojson(tile_data.fetchall())
            with open(target_folder / str(x) / f"{y}.json", "w") as fw:
                fw.write(
                    json.dumps(
                        dict(
                            type="FeatureCollection",
                            features=features,
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
