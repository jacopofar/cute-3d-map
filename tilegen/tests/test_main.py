import main
import shapely
from shapely.geometry.base import BaseGeometry

POLYGON = "POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))"


def geom(wkt: str) -> BaseGeometry:
    return shapely.from_wkt(wkt)


def test_parse_length():
    assert main.parse_length("12") == 12.0
    assert main.parse_length("12.5") == 12.5
    assert main.parse_length("12 m") == 12.0
    assert main.parse_length("12.5 m") == 12.5
    assert main.parse_length("12m") == 12.0
    assert main.parse_length("80 m") == 80.0
    assert main.parse_length(None) is None
    assert main.parse_length("abc") is None
    assert main.parse_length("") is None
    assert main.parse_length("   ") is None


def test_coord_to_tile_london():
    # worked example from the OSM slippy map tilenames wiki
    lon, lat = -0.009330691929342804, 51.50532591783914
    assert main.coord_to_tile(lon, lat, 10) == (511, 340)


def test_coord_to_tile_origin():
    assert main.coord_to_tile(0.0, 0.0, 1) == (1, 1)
    assert main.coord_to_tile(-180.0, 0.0, 1) == (0, 1)


def test_to_building_height_and_color():
    f = main.to_building(
        1,
        {"building": "yes", "height": "12", "building:colour": "#ff0000"},
        geom(POLYGON),
    )
    assert f is not None
    assert f["properties"]["cmtype"] == "building"
    assert f["properties"]["height"] == 12.0
    assert f["properties"]["color"] == "#ff0000"


def test_to_building_levels_fallback():
    f = main.to_building(2, {"building": "yes", "building:levels": "4"}, geom(POLYGON))
    assert f is not None
    assert f["properties"]["height"] == 12.0


def test_to_building_skips_non_polygon():
    assert main.to_building(3, {"building": "yes"}, geom("POINT (0 0)")) is None


def test_to_tree_point_only():
    f = main.to_tree(4, {"natural": "tree"}, geom("POINT (0 0)"))
    assert f is not None
    assert f["properties"]["cmtype"] == "tree"
    assert main.to_tree(5, {"natural": "tree"}, geom("LINESTRING (0 0, 1 1)")) is None


def test_to_tree_row_line_only():
    f = main.to_tree_row(6, {"natural": "tree_row"}, geom("LINESTRING (0 0, 1 1)"))
    assert f is not None
    assert f["properties"]["cmtype"] == "tree_row"
    assert main.to_tree_row(7, {"natural": "tree_row"}, geom("POINT (0 0)")) is None


def test_tile_lonlat_bounds_contains_center():
    min_lon, min_lat, max_lon, max_lat = main.tile_lonlat_bounds(17220, 11723, 15)
    assert min_lon < 9.186 < max_lon
    assert min_lat < 45.497 < max_lat


def test_merge_roads_stitches_and_keeps_short():
    seg1 = geom("LINESTRING (9.19 45.50, 9.191 45.50)")
    seg2 = geom("LINESTRING (9.191 45.50, 9.192 45.50)")
    stub = geom("LINESTRING (9.20 45.50, 9.2001 45.50)")
    box = shapely.box(9.0, 45.0, 9.5, 45.5)
    lines = main.merge_roads([seg1, seg2, stub], box)
    # seg1+seg2 stitch into one 3-point line; the short stub is kept (the
    # minimum-length rule now applies to cycles in the frontend)
    assert sorted(len(list(ln.coords)) for ln in lines) == [2, 3]


def test_merge_roads_clips_to_box():
    box = shapely.box(9.0, 45.0, 9.5, 45.5)
    line = geom("LINESTRING (9.25 45.0, 9.25 45.7)")
    lines = main.merge_roads([line], box)
    assert len(lines) == 1
    assert max(c[1] for c in lines[0].coords) <= 45.5 + 1e-9


def test_tile_to_geojson_splits_render_and_raw():
    building = shapely.to_wkb(geom(POLYGON))
    footway = shapely.to_wkb(geom("LINESTRING (9.19 45.497, 9.191 45.497)"))
    data = [
        (1, {"building": "yes", "height": "10"}, building),
        (2, {"highway": "footway"}, footway),
    ]
    render, raw = main.tile_to_geojson(data, 17220, 11723, 15)
    assert [f["properties"]["cmtype"] for f in render] == ["building"]
    assert len(raw) == 2


def test_tile_to_geojson_merges_drivable_roads():
    min_lon, min_lat, max_lon, max_lat = main.tile_lonlat_bounds(17220, 11723, 15)
    lon = (min_lon + max_lon) / 2
    lat = (min_lat + max_lat) / 2
    d = 0.001  # ~78 m of longitude at this latitude
    a = shapely.to_wkb(geom(f"LINESTRING ({lon} {lat}, {lon + d} {lat})"))
    b = shapely.to_wkb(geom(f"LINESTRING ({lon + d} {lat}, {lon + 2 * d} {lat})"))
    data = [
        (1, {"highway": "residential"}, a),
        (2, {"highway": "residential"}, b),
    ]
    render, _ = main.tile_to_geojson(data, 17220, 11723, 15)
    roads = [f for f in render if f["properties"]["cmtype"] == "road"]
    assert len(roads) == 1
    assert len(roads[0]["geometry"]["coordinates"]) == 3


def test_tile_to_geojson_emits_rail_and_ignores_metro():
    min_lon, min_lat, max_lon, max_lat = main.tile_lonlat_bounds(17220, 11723, 15)
    lon = (min_lon + max_lon) / 2
    lat = (min_lat + max_lat) / 2
    d = 0.001  # ~78 m of longitude at this latitude
    rail = shapely.to_wkb(geom(f"LINESTRING ({lon} {lat}, {lon + 2 * d} {lat})"))
    metro = shapely.to_wkb(
        geom(f"LINESTRING ({lon} {lat + 0.001}, {lon + 2 * d} {lat + 0.001})")
    )
    data = [
        (1, {"railway": "rail"}, rail),
        (2, {"railway": "subway"}, metro),
    ]
    render, _ = main.tile_to_geojson(data, 17220, 11723, 15)
    rails = [f for f in render if f["properties"]["cmtype"] == "rail"]
    assert len(rails) == 1
    assert "/rail/" in rails[0]["id"]


def test_tile_to_geojson_emits_tram_stop():
    stop = shapely.to_wkb(geom("POINT (9.19 45.497)"))
    data = [(1, {"railway": "tram_stop"}, stop)]
    render, _ = main.tile_to_geojson(data, 17220, 11723, 15)
    assert [f["properties"]["cmtype"] for f in render] == ["tram_stop"]
