import geo
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


def test_tree_type_size():
    assert main.tree_type_size({"leaf_type": "needleleaved"}, 0)[0] == "conifer"
    assert main.tree_type_size({"leaf_type": "broadleaved"}, 0)[0] == "broadleaf"
    # genus/species hint at a conifer even without leaf_type
    assert main.tree_type_size({"genus": "Pinus"}, 3)[0] == "conifer"
    # crown diameter -> radius, else height -> 0.25 * height, else seed
    assert main.tree_type_size({"diameter_crown": "6"}, 0)[1] == 3.0
    assert main.tree_type_size({"height": "10"}, 0)[1] == 2.5
    # seed decides when there are no tags
    assert main.tree_type_size({}, 0)[0] == "conifer"  # 0 % 3 == 0
    assert main.tree_type_size({}, 1)[0] == "broadleaf"


def test_to_tree_has_type_and_size():
    f = main.to_tree(
        1,
        {"natural": "tree", "leaf_type": "broadleaved", "height": "8"},
        geom("POINT (0 0)"),
    )
    assert f is not None
    assert f["properties"]["type"] == "broadleaf"
    assert f["properties"]["size"] == 2.0


def test_to_tree_row_line_only():
    f = main.to_tree_row(6, {"natural": "tree_row"}, geom("LINESTRING (0 0, 1 1)"))
    assert f is not None
    assert f["properties"]["cmtype"] == "tree_row"
    assert main.to_tree_row(7, {"natural": "tree_row"}, geom("POINT (0 0)")) is None


def test_tile_lonlat_bounds_contains_center():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    assert min_lon < 9.186 < max_lon
    assert min_lat < 45.497 < max_lat


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


def test_road_oneway():
    assert main.road_oneway({"oneway": "yes"}) == "yes"
    assert main.road_oneway({"oneway": "-1"}) == "-1"
    assert main.road_oneway({"oneway": "no"}) is None
    assert main.road_oneway({"junction": "roundabout"}) == "yes"
    assert main.road_oneway({}) is None
