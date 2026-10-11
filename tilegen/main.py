import json
import logging
import math
import zlib
from pathlib import Path

import click
import duckdb
import quackosm as qosm
import shapely
from shapely.geometry import GeometryCollection, LineString, MultiLineString
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

# railway values whose ways carry trains/trams; used to emit "rail" features
# the frontend drives trains along. Metros (railway=subway) are ignored.
RAILWAYS = frozenset({"rail", "tram"})


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


def tile_lonlat_bounds(x: int, y: int, zoom: int) -> tuple[float, float, float, float]:
    """(min_lon, min_lat, max_lon, max_lat) of a slippy tile in EPSG:4326."""
    n = 2**zoom
    min_lon = x / n * 360 - 180
    max_lon = (x + 1) / n * 360 - 180
    max_lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    min_lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return min_lon, min_lat, max_lon, max_lat


def merge_roads(
    geometries: list[BaseGeometry],
    box: BaseGeometry,
) -> list[BaseGeometry]:
    """Clip road ways to the tile and stitch consecutive segments into longer
    lines. Short segments are kept: the minimum-length rule is applied to whole
    cycles in the frontend, so dropping short connectors here would fragment
    the road graph."""
    clipped: list[LineString] = []
    for g in geometries:
        c = shapely.intersection(g, box)
        if c.is_empty:
            continue
        if isinstance(c, LineString):
            clipped.append(c)
        elif isinstance(c, MultiLineString):
            clipped.extend(c.geoms)
        elif isinstance(c, GeometryCollection):
            clipped.extend(p for p in c.geoms if isinstance(p, LineString))
    if not clipped:
        return []
    merged = shapely.line_merge(shapely.union_all(clipped))
    if isinstance(merged, MultiLineString):
        lines = list(merged.geoms)
    elif isinstance(merged, LineString):
        lines = [merged]
    else:
        lines = []
    return list(lines)


def lines_to_features(
    geometries: list[BaseGeometry],
    box: BaseGeometry,
    cmtype: str,
    tile_x: int,
    tile_y: int,
) -> list[dict]:
    """Clip + stitch the linear features of a tile into cmtype features."""
    return [
        {
            "type": "feature",
            "id": f"{tile_x}/{tile_y}/{cmtype}/{i}",
            "geometry": json.loads(shapely.to_geojson(line)),
            "properties": {"cmtype": cmtype},
        }
        for i, line in enumerate(merge_roads(geometries, box))
    ]


def road_oneway(tags) -> str | None:
    """Normalized oneway direction of a highway way, or None if two-way."""
    value = tags.get("oneway")
    if value in ("yes", "true", "1"):
        return "yes"
    if value in ("-1", "reverse"):
        return "-1"
    if value in ("no", "false", "0"):
        return None
    if tags.get("junction") in ("roundabout", "circular"):
        return "yes"
    return None


def clip_line(line: LineString, box: BaseGeometry) -> list[LineString]:
    """Intersect a line with the tile box, keeping the line's own direction so
    oneway semantics survive clipping."""
    clipped = shapely.intersection(line, box)
    if clipped.is_empty:
        return []
    if isinstance(clipped, LineString):
        parts = [clipped]
    elif isinstance(clipped, MultiLineString):
        parts = list(clipped.geoms)
    elif isinstance(clipped, GeometryCollection):
        parts = [p for p in clipped.geoms if isinstance(p, LineString)]
    else:
        parts = []
    start = shapely.Point(line.coords[0])
    result = []
    for part in parts:
        first = shapely.Point(part.coords[0])
        last = shapely.Point(part.coords[-1])
        if first.distance(start) > last.distance(start):
            part = shapely.reverse(part)
        result.append(part)
    return result


def tile_to_geojson(data, tile_x: int, tile_y: int, zoom: int) -> tuple[list, list]:
    ret = []
    ret_raw = []
    # two-way roads are merged into longer lines (direction does not matter);
    # one-way roads are kept per way so their direction survives
    bidir_roads: list[BaseGeometry] = []
    oneway_roads: list[tuple[LineString, str]] = []
    rail_geometries: list[BaseGeometry] = []
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
        elif tags.get("railway") == "tram_stop":
            # tram stops are points the trams pause at (in addition to
            # crossings); kept raw as cmtype "tram_stop"
            if s.geom_type == "Point":
                ret.append(
                    {
                        "type": "feature",
                        "id": feature_id,
                        "geometry": json.loads(shapely.to_geojson(s)),
                        "properties": {"cmtype": "tram_stop"},
                    }
                )
        elif tags.get("highway") in DRIVABLE_HIGHWAYS:
            oneway = road_oneway(tags)
            if oneway is None:
                bidir_roads.append(s)
            elif isinstance(s, LineString):
                oneway_roads.append((s, oneway))
            elif isinstance(s, MultiLineString):
                oneway_roads.extend((part, oneway) for part in s.geoms)
        elif tags.get("railway") in RAILWAYS:
            rail_geometries.append(s)

    if bidir_roads or oneway_roads or rail_geometries:
        box = shapely.box(*tile_lonlat_bounds(tile_x, tile_y, zoom))
        ret += lines_to_features(bidir_roads, box, "road", tile_x, tile_y)
        ret += lines_to_features(rail_geometries, box, "rail", tile_x, tile_y)
        # one-way roads: clipped per way so the direction is preserved
        index = 0
        for geom, oneway in oneway_roads:
            for line in clip_line(geom, box):
                ret.append(
                    {
                        "type": "feature",
                        "id": f"{tile_x}/{tile_y}/oneway/{index}",
                        "geometry": json.loads(shapely.to_geojson(line)),
                        "properties": {"cmtype": "road", "oneway": oneway},
                    }
                )
                index += 1

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
            features, raw_features = tile_to_geojson(
                tile_data.fetchall(), x, y, zoom_level
            )
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
