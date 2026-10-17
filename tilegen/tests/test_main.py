import json

import geo
import impute
import main
import shapely
import traffic
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


def test_to_building_imputes_missing_color_and_roof():
    distributions = {
        "color": impute.Distribution.from_counts({"white": 1}),
        "roof_shape": impute.Distribution.from_counts({"gabled": 1}),
        "roof_color": impute.Distribution.from_counts({"#bf7182": 1}),
    }
    f = main.to_building(9, {"building": "yes"}, geom(POLYGON), distributions)
    assert f is not None
    assert f["properties"]["color"] == "white"
    assert f["properties"]["roof_shape"] == "gabled"
    assert f["properties"]["roof_color"] == "#bf7182"
    # and it says which of them were imputed rather than tagged
    assert sorted(f["properties"]["imputed"]) == [
        "color",
        "roof_color",
        "roof_shape",
    ]


def test_to_building_keeps_real_roof_tags():
    distributions = {
        "roof_shape": impute.Distribution.from_counts({"flat": 1}),
    }
    f = main.to_building(
        10,
        {"building": "yes", "roof:shape": "hipped", "roof:colour": "red"},
        geom(POLYGON),
        distributions,
    )
    assert f is not None
    assert f["properties"]["roof_shape"] == "hipped"
    assert f["properties"]["roof_color"] == "red"
    # nothing was sampled for this one
    assert "imputed" not in f["properties"]


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


def test_to_stop_points_are_point_only():
    f = main.to_traffic_signal(
        8, {"highway": "traffic_signals"}, geom("POINT (9.18 45.5)")
    )
    assert f is not None
    assert f["properties"]["cmtype"] == "traffic_signal"
    c = main.to_crossing(9, {"highway": "crossing"}, geom("POINT (9.18 45.5)"))
    assert c is not None
    assert c["properties"]["cmtype"] == "crossing"
    # the odd crossing way in the extract must not abort the tile
    assert (
        main.to_crossing(10, {"highway": "crossing"}, geom("LINESTRING (0 0, 1 1)"))
        is None
    )


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


def test_tile_to_geojson_includes_signals_and_crossings():
    signal = shapely.to_wkb(geom("POINT (9.19 45.497)"))
    crossing = shapely.to_wkb(geom("POINT (9.191 45.497)"))
    data = [
        (1, {"highway": "traffic_signals"}, signal),
        (2, {"highway": "crossing"}, crossing),
    ]
    render, raw = main.tile_to_geojson(data, 17220, 11723, 15)
    assert [f["properties"]["cmtype"] for f in render] == [
        "traffic_signal",
        "crossing",
    ]
    assert len(raw) == 2


def test_tile_to_geojson_includes_trees_and_rows():
    tree = shapely.to_wkb(geom("POINT (9.19 45.497)"))
    row = shapely.to_wkb(geom("LINESTRING (9.19 45.497, 9.191 45.497)"))
    data = [
        (1, {"natural": "tree"}, tree),
        (2, {"natural": "tree_row"}, row),
    ]
    render, _raw = main.tile_to_geojson(data, 17220, 11723, 15)
    assert [f["properties"]["cmtype"] for f in render] == ["tree", "tree_row"]


def test_water_kind_classifies_areas_and_lines():
    assert main.water_kind({"natural": "water"}) == "lake"
    assert main.water_kind({"natural": "water", "water": "pond"}) == "pond"
    assert main.water_kind({"natural": "wetland"}) == "wetland"
    assert main.water_kind({"landuse": "reservoir"}) == "reservoir"
    assert main.water_kind({"waterway": "riverbank"}) == "lake"
    assert main.water_kind({"water": "river"}) == "river"
    assert main.water_kind({"building": "yes"}) is None


def test_is_water_accepts_channels_but_not_other_ways():
    assert main.is_water({"waterway": "canal"})
    assert main.is_water({"natural": "water"})
    assert not main.is_water({"waterway": "weir"})  # not a channel
    assert not main.is_water({"highway": "residential"})


def test_to_water_clips_an_area_to_the_tile():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    # a lake much larger than the tile, centred on it
    lake = shapely.box(min_lon - 1, min_lat - 1, max_lon + 1, max_lat + 1)
    f = main.to_water(1, {"natural": "water"}, lake, box)
    assert f is not None
    assert f["properties"] == {"cmtype": "water", "water": "lake"}
    clipped = shapely.from_geojson(json.dumps(f["geometry"]))
    assert clipped.equals(box)
    # an area outside the tile is dropped
    away = shapely.box(max_lon + 0.01, max_lat + 0.01, max_lon + 0.02, max_lat + 0.02)
    assert main.to_water(2, {"natural": "water"}, away, box) is None


def test_to_water_clips_a_waterway_line_to_the_tile():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    line = shapely.LineString([(min_lon - 0.001, min_lat), (max_lon + 0.001, min_lat)])
    f = main.to_water(3, {"waterway": "canal"}, line, box)
    assert f is not None
    assert f["properties"]["water"] == "canal"
    clipped = shapely.from_geojson(json.dumps(f["geometry"]))
    assert clipped.geom_type == "LineString"
    assert round(clipped.bounds[0], 9) == round(min_lon, 9)


def test_to_water_keeps_the_name():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    lake = shapely.box(min_lon, min_lat, max_lon, max_lat)
    f = main.to_water(5, {"natural": "water", "name": "Lago"}, lake, box)
    assert f is not None
    assert f["properties"]["name"] == "Lago"
    # an unnamed water body has no name key at all
    plain = main.to_water(6, {"natural": "water"}, lake, box)
    assert plain is not None
    assert "name" not in plain["properties"]


def test_parse_level():
    assert main.parse_level("0") == 0
    assert main.parse_level("-1") == -1
    assert main.parse_level("1.5") == 1.5
    assert main.parse_level("0;1") == 0  # a list: the first entry wins
    assert main.parse_level("-1--2") == -1  # a range: the low end
    assert main.parse_level("basement") is None
    assert main.parse_level(None) is None


def test_vertical_level_prefers_layer_then_level():
    assert main.vertical_level({"layer": "-2"}) == -2
    assert main.vertical_level({"level": "-1"}) == -1
    assert main.vertical_level({"layer": "1", "level": "0"}) == 1  # layer wins
    assert main.vertical_level({"layer": "0;-1"}) == 0  # first number
    assert main.vertical_level({}) is None


def test_to_water_reports_a_negative_vertical_level():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    lake = shapely.box(min_lon, min_lat, max_lon, max_lat)
    # OSM marks a below-ground waterway with `layer` (Seveso is layer=-2)
    underwater = main.to_water(7, {"natural": "water", "layer": "-2"}, lake, box)
    assert underwater is not None
    assert underwater["properties"]["layer"] == -2
    # a plain `level` is still honoured
    by_level = main.to_water(8, {"natural": "water", "level": "-1"}, lake, box)
    assert by_level is not None
    assert by_level["properties"]["layer"] == -1
    # no vertical tag -> no layer key, so the frontend sees a surface feature
    plain = main.to_water(9, {"natural": "water"}, lake, box)
    assert plain is not None
    assert "layer" not in plain["properties"]


def test_to_water_ignores_a_non_channel_waterway():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    line = shapely.LineString([(min_lon, min_lat), (max_lon, max_lat)])
    assert main.to_water(4, {"waterway": "weir"}, line, box) is None


def test_tile_to_geojson_includes_water():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    cx = (min_lon + max_lon) / 2
    cy = (min_lat + max_lat) / 2
    pond = shapely.to_wkb(
        geom(
            "POLYGON (("
            f"{cx} {cy}, {cx + 2e-4} {cy}, {cx + 2e-4} {cy + 2e-4}, "
            f"{cx} {cy + 2e-4}, {cx} {cy}))"
        )
    )
    render, raw = main.tile_to_geojson(
        [(1, {"natural": "water"}, pond)], 17220, 11723, 15
    )
    assert [f["properties"]["cmtype"] for f in render] == ["water"]
    assert render[0]["properties"]["water"] == "lake"
    assert len(raw) == 1


def test_crossing_points_from_rows_keeps_points_only():
    point = shapely.to_wkb(geom("POINT (9.18 45.5)"))
    line = shapely.to_wkb(geom("LINESTRING (0 0, 1 1)"))
    rows = [
        ("traffic_signals", point),
        ("crossing", shapely.to_wkb(geom("POINT (9.19 45.5)"))),
        ("crossing", line),  # the odd crossing LineString in the extract
        ("residential", point),  # not a stop kind
    ]
    points = main.crossing_points_from_rows(rows)
    assert [(p.kind, round(p.lon, 2)) for p in points] == [
        ("traffic_signal", 9.18),
        ("crossing", 9.19),
    ]


def test_group_features_by_tile():
    wkb = shapely.to_wkb(geom("POINT (9.18 45.5)"))
    rows = [
        (17220, 11723, 2, {"natural": "tree"}, wkb),
        (17220, 11723, 1, {"building": "yes"}, wkb),
        (17221, 11723, 3, {"building": "yes"}, wkb),
    ]
    by_tile = main.group_features_by_tile(rows)
    assert set(by_tile) == {(17220, 11723), (17221, 11723)}
    # sorted by id, so the order does not depend on the query's join order
    assert [feature[0] for feature in by_tile[(17220, 11723)]] == [1, 2]
    assert by_tile[(17221, 11723)][0][0] == 3


def square_loops():
    lon, lat, d = 9.18, 45.5, 0.001
    corners = [
        (lon - d, lat - d),
        (lon + d, lat - d),
        (lon + d, lat + d),
        (lon - d, lat + d),
    ]
    ways = [
        traffic.Way([corners[i], corners[(i + 1) % 4]], highway="residential")
        for i in range(4)
    ]
    graph = traffic.build_graph(ways)
    loops = traffic.find_loops(graph, traffic.TrafficConfig(min_loop_length=80.0))
    traffic.assign_vehicles(loops, traffic.TrafficConfig(spacing=50.0))
    return loops


def test_write_loop_report_writes_markdown_and_geojson(tmp_path):
    loops = square_loops()
    points = [traffic.CrossingPoint(lon=9.18, lat=45.5, kind="traffic_signal")]
    polygon = geom(
        "POLYGON ((9.17 45.49, 9.19 45.49, 9.19 45.51, 9.17 45.51, 9.17 45.49))"
    )
    main.write_loop_report({"car": loops}, tmp_path, polygon, points)

    assert "signals and crossings" in (tmp_path / "loops.md").read_text()
    document = json.loads((tmp_path / "loops.geojson").read_text())
    geometries = {f["geometry"]["type"] for f in document["features"]}
    assert geometries == {"LineString", "Point"}


def test_road_oneway():
    assert main.road_oneway({"oneway": "yes"}) == "yes"
    assert main.road_oneway({"oneway": "-1"}) == "-1"
    assert main.road_oneway({"oneway": "no"}) is None
    assert main.road_oneway({"junction": "roundabout"}) == "yes"
    assert main.road_oneway({}) is None


def squareloops_ways():
    lon, lat, d = 9.18, 45.5, 0.001
    corners = [
        (lon - d, lat - d),
        (lon + d, lat - d),
        (lon + d, lat + d),
        (lon - d, lat + d),
    ]
    return [
        traffic.Way([corners[i], corners[(i + 1) % 4]], highway="residential")
        for i in range(4)
    ]


def test_load_or_build_fleets_reuses_the_cache(tmp_path, monkeypatch):
    ways = {"car": squareloops_ways()}
    configs = {"car": traffic.TrafficConfig(min_loop_length=80.0)}
    calls = {"n": 0}
    real_build = traffic.build_fleets

    def counting_build(ways_by_kind, configs):
        calls["n"] += 1
        return real_build(ways_by_kind, configs)

    monkeypatch.setattr(main, "build_fleets", counting_build)

    first = main.load_or_build_fleets(ways, configs, tmp_path, use_cache=True)
    assert calls["n"] == 1
    assert list(tmp_path.iterdir())  # a cache file was written

    second = main.load_or_build_fleets(ways, configs, tmp_path, use_cache=True)
    assert calls["n"] == 1  # served from disk, not rebuilt
    assert second == first


def test_load_or_build_fleets_without_cache_always_builds(tmp_path, monkeypatch):
    ways = {"car": squareloops_ways()}
    configs = {"car": traffic.TrafficConfig(min_loop_length=80.0)}
    calls = {"n": 0}
    real_build = traffic.build_fleets

    def counting_build(ways_by_kind, configs):
        calls["n"] += 1
        return real_build(ways_by_kind, configs)

    monkeypatch.setattr(main, "build_fleets", counting_build)

    main.load_or_build_fleets(ways, configs, tmp_path, use_cache=False)
    main.load_or_build_fleets(ways, configs, tmp_path, use_cache=False)
    assert calls["n"] == 2
    assert not list(tmp_path.iterdir())  # nothing was cached
