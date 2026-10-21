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


def test_to_building_reports_the_building_value_and_religion():
    # the frontend needs to know a polygon is a church: `building` always, and
    # `religion` for a place of worship
    church = main.to_building(
        11,
        {
            "building": "church",
            "amenity": "place_of_worship",
            "religion": "christian",
        },
        geom(POLYGON),
    )
    assert church is not None
    assert church["properties"]["building"] == "church"
    assert church["properties"]["religion"] == "christian"

    # a plain apartment block carries the value but no religion
    flats = main.to_building(12, {"building": "apartments"}, geom(POLYGON))
    assert flats is not None
    assert flats["properties"]["building"] == "apartments"
    assert "religion" not in flats["properties"]

    # religion outside a place of worship is not what the frontend keys on
    hotel = main.to_building(
        13, {"building": "hotel", "religion": "christian"}, geom(POLYGON)
    )
    assert hotel is not None
    assert "religion" not in hotel["properties"]


def test_to_building_reports_a_glass_facade():
    # both material tags count, case-insensitively, and a `;` list is searched
    # word by word: OSM writes `plaster;glass` for a partly glazed wall
    for tag, value in (
        ("building:material", "glass"),
        ("building:facade:material", "Glass"),
        ("building:material", "plaster;glass"),
        ("building:facade:material", "mirror"),
    ):
        f = main.to_building(14, {"building": "yes", tag: value}, geom(POLYGON))
        assert f is not None
        assert f["properties"]["glass"] is True, (tag, value)

    # anything else is simply absent: properties are filtered for None
    plain = main.to_building(
        15, {"building": "yes", "building:material": "brick"}, geom(POLYGON)
    )
    assert plain is not None
    assert "glass" not in plain["properties"]


def test_is_glass():
    assert main.is_glass({"building:material": "glass"})
    assert main.is_glass({"building:facade:material": "mirror;glass"})
    assert not main.is_glass({"building:material": "concrete"})
    assert not main.is_glass({})
    # imputed colors never imply glass: this is reported, never sampled
    f = main.to_building(
        16,
        {"building": "yes"},
        geom(POLYGON),
        {"color": impute.Distribution.from_counts({"white": 1})},
    )
    assert f is not None
    assert "glass" not in f["properties"]


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


def test_bench_direction_maps_compass_and_degrees():
    for value, expected in (("N", 0.0), ("E", 90.0), ("S", 180.0), ("W", 270.0)):
        assert main.bench_direction({"direction": value}) == expected
        # OSM is inconsistent about the case
        assert main.bench_direction({"direction": value.lower()}) == expected
    assert main.bench_direction({"direction": "135"}) == 135.0
    assert main.bench_direction({"direction": "450"}) == 90.0  # normalized
    # these relate to a nearby way, which the tiles do not carry
    assert main.bench_direction({"direction": "parallel"}) is None
    assert main.bench_direction({"direction": "perpendicular"}) is None
    assert main.bench_direction({}) is None


def test_line_bearing_is_a_compass_bearing():
    # a due-east line is 90 degrees, a due-north one 0
    east = main.line_bearing(geom("LINESTRING (9.18 45.5, 9.181 45.5)"))
    north = main.line_bearing(geom("LINESTRING (9.18 45.5, 9.18 45.501)"))
    assert east is not None and round(east) == 90
    assert north is not None and round(north) == 0
    # a zero-length line has no direction
    assert main.line_bearing(geom("LINESTRING (9.18 45.5, 9.18 45.5)")) is None


def test_to_bench_point_keeps_the_direction():
    f = main.to_bench(
        11, {"amenity": "bench", "direction": "N"}, geom("POINT (9.18 45.5)")
    )
    assert f is not None
    assert f["properties"] == {"cmtype": "bench", "direction": 0.0}
    # no direction tag -> no direction key, so the frontend picks its own
    plain = main.to_bench(12, {"amenity": "bench"}, geom("POINT (9.18 45.5)"))
    assert plain is not None
    assert plain["properties"] == {"cmtype": "bench"}


def test_to_bench_line_collapses_to_the_midpoint():
    line = geom("LINESTRING (9.18 45.5, 9.19 45.5)")
    f = main.to_bench(13, {"amenity": "bench"}, line)
    assert f is not None
    # the facing follows the line when the tag does not give one
    assert round(f["properties"]["direction"]) == 90
    lon, lat = f["geometry"]["coordinates"]
    assert f["geometry"]["type"] == "Point"
    assert round(lon, 4) == 9.185 and round(lat, 4) == 45.5
    # a tag wins over the line
    tagged = main.to_bench(14, {"amenity": "bench", "direction": "W"}, line)
    assert tagged is not None
    assert tagged["properties"]["direction"] == 270.0


def test_to_bench_ignores_odd_geometry():
    # the extract has one Polygon bench that must not abort the tile
    assert (
        main.to_bench(15, {"amenity": "bench"}, geom("POLYGON ((0 0, 1 0, 1 1, 0 0))"))
        is None
    )


def test_tile_to_geojson_includes_benches():
    bench = shapely.to_wkb(geom("POINT (9.19 45.497)"))
    polygon = shapely.to_wkb(geom("POLYGON ((0 0, 1 0, 1 1, 0 0))"))
    data = [
        (1, {"amenity": "bench"}, bench),
        (2, {"amenity": "bench"}, polygon),
    ]
    render, _raw = main.tile_to_geojson(data, 17220, 11723, 15)
    assert [f["properties"]["cmtype"] for f in render] == ["bench"]


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


def test_to_fence_clips_a_line_to_the_tile():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    # a fence running across the tile and out both sides
    line = shapely.LineString(
        [(min_lon - 0.001, max_lat - 0.001), (max_lon + 0.001, max_lat - 0.001)]
    )
    f = main.to_fence(1, {"barrier": "fence"}, line, box)
    assert f is not None
    assert f["properties"] == {"cmtype": "fence", "barrier": "fence"}
    clipped = shapely.from_geojson(json.dumps(f["geometry"]))
    assert clipped.geom_type == "LineString"
    assert round(clipped.bounds[0], 9) == round(min_lon, 9)
    # a fence outside the tile is dropped
    away = shapely.LineString(
        [(max_lon + 0.01, max_lat + 0.01), (max_lon + 0.02, max_lat + 0.01)]
    )
    assert main.to_fence(2, {"barrier": "fence"}, away, box) is None


def test_to_fence_takes_a_fenced_area_outline():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    # a barrier closed into an area: the fence is its outline
    area = shapely.box(min_lon, min_lat, max_lon, max_lat)
    f = main.to_fence(3, {"barrier": "fence"}, area, box)
    assert f is not None
    assert shapely.from_geojson(json.dumps(f["geometry"])).equals(box.boundary)
    # a guard rail rides along with the same shape, for the frontend to color
    rail = main.to_fence(4, {"barrier": "guard_rail"}, area, box)
    assert rail is not None
    assert rail["properties"]["barrier"] == "guard_rail"


def test_to_fence_drops_slivers_and_ignores_other_barriers():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    # a line just poking into the tile leaves only a stub, which is dropped
    stub = shapely.LineString(
        [(min_lon - 0.0005, min_lat + 0.0005), (min_lon + 0.0000001, min_lat + 0.0005)]
    )
    assert main.to_fence(5, {"barrier": "fence"}, stub, box) is None
    # a wall or a gate is not a fence
    line = shapely.LineString([(min_lon, min_lat), (max_lon, max_lat)])
    assert main.to_fence(6, {"barrier": "wall"}, line, box) is None
    assert main.to_fence(7, {"barrier": "gate"}, line, box) is None


def test_to_fence_keeps_the_name():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    line = shapely.LineString([(min_lon, min_lat), (max_lon, max_lat)])
    named = main.to_fence(8, {"barrier": "fence", "name": "Recinto"}, line, box)
    assert named is not None
    assert named["properties"]["name"] == "Recinto"
    plain = main.to_fence(9, {"barrier": "fence"}, line, box)
    assert plain is not None
    assert "name" not in plain["properties"]


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


def test_outside_cemeteries_drops_ways_inside_the_walls():
    cemetery = shapely.box(0, 0, 10, 10)
    inside = main.ParkingWay(id="inside", coords=[(1, 1), (9, 9)], highway="service")
    outside = main.ParkingWay(
        id="outside", coords=[(20, 20), (30, 30)], highway="service"
    )
    kept = main.outside_cemeteries([inside, outside], cemetery)
    assert [way.id for way in kept] == ["outside"]
    # no cemeteries (or an empty union) changes nothing
    assert main.outside_cemeteries([inside, outside], None) == [inside, outside]


def test_green_kind_classifies_the_two_styles():
    # mown lawn / pitch / garden
    assert main.green_kind({"landuse": "grass"}) == "grass"
    assert main.green_kind({"landuse": "village_green"}) == "grass"
    assert main.green_kind({"landuse": "meadow"}) == "grass"
    assert main.green_kind({"natural": "grassland"}) == "grass"
    assert main.green_kind({"leisure": "pitch"}) == "grass"
    assert main.green_kind({"leisure": "garden"}) == "grass"
    # park / wood / scrub
    assert main.green_kind({"leisure": "park"}) == "dense"
    assert main.green_kind({"leisure": "nature_reserve"}) == "dense"
    assert main.green_kind({"natural": "wood"}) == "dense"
    assert main.green_kind({"natural": "scrub"}) == "dense"
    assert main.green_kind({"natural": "heath"}) == "dense"
    assert main.green_kind({"landuse": "forest"}) == "dense"
    assert main.green_kind({"landuse": "orchard"}) == "dense"
    # farmland is deliberately not green (it would cover the whole province)
    assert main.green_kind({"landuse": "farmland"}) is None
    assert main.green_kind({"natural": "farmland"}) is None
    assert main.green_kind({"building": "yes"}) is None


def test_is_cemetery_accepts_landuse_and_grave_yard():
    assert main.is_cemetery({"landuse": "cemetery"})
    assert main.is_cemetery({"amenity": "grave_yard"})
    assert not main.is_cemetery({"landuse": "grass"})
    assert not main.is_cemetery({"building": "yes"})


def test_to_cemetery_clips_and_keeps_the_name():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    # a cemetery much larger than the tile, centred on it
    cemetery = shapely.box(min_lon - 1, min_lat - 1, max_lon + 1, max_lat + 1)
    f = main.to_cemetery(1, {"landuse": "cemetery", "name": "Cimitero"}, cemetery, box)
    assert f is not None
    assert f["properties"] == {"cmtype": "cemetery", "name": "Cimitero"}
    clipped = shapely.from_geojson(json.dumps(f["geometry"]))
    assert clipped.equals(box)
    # an unnamed cemetery has no name key
    plain = main.to_cemetery(2, {"amenity": "grave_yard"}, cemetery, box)
    assert plain is not None
    assert "name" not in plain["properties"]
    # a sliver at the tile edge is dropped
    away = shapely.box(max_lon + 1, max_lat + 1, max_lon + 1.0001, max_lat + 1.0001)
    assert main.to_cemetery(3, {"landuse": "cemetery"}, away, box) is None


def test_furniture_kind_covers_the_street_props():
    assert main.furniture_kind({"barrier": "bollard"}) == "bollard"
    assert main.furniture_kind({"amenity": "waste_basket"}) == "bin"
    assert main.furniture_kind({"amenity": "bicycle_parking"}) == "bike_rack"
    assert main.furniture_kind({"amenity": "post_box"}) == "post_box"
    assert main.furniture_kind({"amenity": "drinking_water"}) == "drinking_water"
    assert main.furniture_kind({"tourism": "information"}) == "info_board"
    assert main.furniture_kind({"emergency": "fire_hydrant"}) == "hydrant"
    assert main.furniture_kind({"amenity": "bench"}) is None
    assert main.furniture_kind({"building": "yes"}) is None


def test_to_furniture_handles_points_lines_and_areas():
    point = shapely.Point(9.19, 45.46)
    bollard = main.to_furniture(1, {"barrier": "bollard"}, point)
    assert bollard is not None
    assert bollard["properties"] == {"cmtype": "furniture", "furniture": "bollard"}
    assert bollard["geometry"]["type"] == "Point"

    # a rack mapped as a line keeps its bearing and collapses to the midpoint
    line = shapely.LineString([(9.19, 45.46), (9.1901, 45.46)])
    rack = main.to_furniture(2, {"amenity": "bicycle_parking"}, line)
    assert rack is not None
    assert rack["properties"]["furniture"] == "bike_rack"
    assert rack["properties"]["angle"] == 90.0
    assert rack["geometry"]["type"] == "Point"

    # and one mapped as an area collapses to the centroid
    area = shapely.box(9.19, 45.46, 9.1901, 45.4601)
    parking = main.to_furniture(3, {"amenity": "bicycle_parking"}, area)
    assert parking is not None
    assert parking["geometry"]["type"] == "Point"
    assert "angle" not in parking["properties"]
    assert main.to_furniture(4, {"amenity": "bench"}, point) is None


def test_transit_kind_prefers_metro_and_separates_tram():
    assert main.transit_kind({"railway": "subway_entrance"}) == "metro"
    assert (
        main.transit_kind({"railway": "subway_entrance", "highway": "bus_stop"})
        == "metro"
    )
    assert main.transit_kind({"railway": "tram_stop"}) == "tram"
    assert main.transit_kind({"highway": "bus_stop"}) == "bus"
    assert main.transit_kind({"highway": "crossing"}) is None


def test_to_transit_stop_carries_name_and_shelter():
    point = shapely.Point(9.19, 45.46)
    metro = main.to_transit_stop(
        1, {"railway": "subway_entrance", "name": "Duomo"}, point
    )
    assert metro is not None
    assert metro["properties"] == {
        "cmtype": "transit_stop",
        "stop": "metro",
        "name": "Duomo",
    }
    bus = main.to_transit_stop(
        2, {"highway": "bus_stop", "name": "Via Roma", "shelter": "yes"}, point
    )
    assert bus is not None
    assert bus["properties"] == {
        "cmtype": "transit_stop",
        "stop": "bus",
        "name": "Via Roma",
        "shelter": True,
    }
    plain = main.to_transit_stop(3, {"highway": "bus_stop"}, point)
    assert plain is not None
    assert "shelter" not in plain["properties"]
    assert main.to_transit_stop(4, {"highway": "crossing"}, point) is None


def test_to_fountain_sizes_a_mapped_basin():
    point = shapely.Point(9.19, 45.46)
    node = main.to_fountain(1, {"amenity": "fountain"}, point)
    assert node is not None
    assert node["properties"] == {"cmtype": "fountain", "size": 2.4}

    basin = shapely.box(9.19, 45.46, 9.1902, 45.4602)
    area = main.to_fountain(2, {"amenity": "fountain", "name": "Fontana"}, basin)
    assert area is not None
    assert area["properties"]["name"] == "Fontana"
    assert 1.5 <= area["properties"]["size"] <= 12
    assert area["geometry"]["type"] == "Point"
    assert main.to_fountain(3, {"amenity": "bench"}, point) is None


def test_to_green_clips_a_park_to_the_tile():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    # a park much larger than the tile, centred on it
    park = shapely.box(min_lon - 1, min_lat - 1, max_lon + 1, max_lat + 1)
    f = main.to_green(1, {"leisure": "park", "name": "Parco"}, park, box)
    assert f is not None
    assert f["properties"] == {"cmtype": "green", "green": "dense", "name": "Parco"}
    clipped = shapely.from_geojson(json.dumps(f["geometry"]))
    assert clipped.equals(box)


def test_to_green_drops_a_sliver_below_the_area_threshold():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    # ~2 m x 2 m: a few square meters, below MIN_GREEN_AREA
    step = 2.0 / 111320.0
    sliver = shapely.box(
        min_lon + 0.001, min_lat + 0.001, min_lon + 0.001 + step, min_lat + 0.001 + step
    )
    assert main.to_green(2, {"landuse": "grass"}, sliver, box) is None
    # a proper lawn is kept, and reports the grass style
    lawn = shapely.box(min_lon + 1e-4, min_lat + 1e-4, min_lon + 4e-4, min_lat + 4e-4)
    kept = main.to_green(3, {"landuse": "grass"}, lawn, box)
    assert kept is not None
    assert kept["properties"]["green"] == "grass"


def test_to_green_ignores_non_area_geometries():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    line = shapely.LineString([(min_lon, min_lat), (max_lon, max_lat)])
    assert main.to_green(4, {"leisure": "park"}, line, box) is None
    # a feature that is not green at all is ignored
    assert main.to_green(5, {"building": "yes"}, box, box) is None


def test_tile_to_geojson_adds_green_after_water():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    cx = (min_lon + max_lon) / 2
    cy = (min_lat + max_lat) / 2
    polygon = shapely.to_wkb(
        geom(
            "POLYGON (("
            f"{cx} {cy}, {cx + 2e-4} {cy}, {cx + 2e-4} {cy + 2e-4}, "
            f"{cx} {cy + 2e-4}, {cx} {cy}))"
        )
    )
    data = [
        # a wetland that also carries landuse=grass stays water: the water
        # branch runs first, so no green is emitted for it
        (1, {"natural": "wetland", "landuse": "grass"}, polygon),
        (2, {"leisure": "park"}, polygon),
    ]
    render, _raw = main.tile_to_geojson(data, 17220, 11723, 15)
    assert [f["properties"]["cmtype"] for f in render] == ["water", "green"]
    assert render[1]["properties"]["green"] == "dense"


def test_to_aeroway_line_keeps_the_whole_geometry_and_a_default_width():
    line = geom("LINESTRING (9.27 45.44, 9.28 45.45)")
    f = main.to_aeroway(1, {"aeroway": "runway"}, line)
    assert f is not None
    assert f["properties"] == {
        "cmtype": "aeroway",
        "aeroway": "runway",
        "width": 45.0,
    }
    # the whole line is stored (not clipped) and the feature keeps its id, so
    # the frontend can dedupe a runway that spans tiles
    assert f["id"] == 1
    assert shapely.from_geojson(json.dumps(f["geometry"])).equals(line)


def test_to_aeroway_uses_the_width_tag():
    line = geom("LINESTRING (0 0, 1 1)")
    f = main.to_aeroway(2, {"aeroway": "taxiway", "width": "7.5"}, line)
    assert f is not None
    assert f["properties"]["width"] == 7.5


def test_to_aeroway_areas_and_helipad():
    area = geom(POLYGON)
    apron = main.to_aeroway(3, {"aeroway": "apron"}, area)
    assert apron is not None
    # an area carries no width: its extent is the polygon
    assert apron["properties"] == {"cmtype": "aeroway", "aeroway": "apron"}
    # a helipad mapped as a node has nothing to draw
    assert main.to_aeroway(4, {"aeroway": "helipad"}, geom("POINT (9.2 45.5)")) is None


def test_to_aeroway_ignores_other_aeroway_kinds():
    assert main.to_aeroway(5, {"aeroway": "hangar"}, geom(POLYGON)) is None
    # a runway that came through as an area is dropped rather than ribboned
    assert main.to_aeroway(6, {"aeroway": "runway"}, geom(POLYGON)) is None


def test_tile_to_geojson_includes_aeroway():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    cx = (min_lon + max_lon) / 2
    cy = (min_lat + max_lat) / 2
    runway = shapely.to_wkb(geom(f"LINESTRING ({cx} {cy}, {cx + 1e-4} {cy + 1e-4})"))
    render, raw = main.tile_to_geojson(
        [(1, {"aeroway": "runway"}, runway)], 17220, 11723, 15
    )
    assert [f["properties"]["cmtype"] for f in render] == ["aeroway"]
    assert render[0]["properties"]["aeroway"] == "runway"
    assert len(raw) == 1


def test_tile_to_geojson_includes_fence():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    line = shapely.to_wkb(
        geom(
            f"LINESTRING ({min_lon + 1e-4} {min_lat + 1e-4}, "
            f"{max_lon - 1e-4} {max_lat - 1e-4})"
        )
    )
    render, raw = main.tile_to_geojson(
        [(1, {"barrier": "fence"}, line)], 17220, 11723, 15
    )
    assert [f["properties"]["cmtype"] for f in render] == ["fence"]
    assert render[0]["properties"]["barrier"] == "fence"
    assert len(raw) == 1


def test_is_bridge_and_tunnel_tags():
    assert main.is_bridge({"bridge": "yes", "highway": "residential"})
    assert main.is_bridge({"bridge": "viaduct", "railway": "rail"})
    assert main.is_bridge({"man_made": "bridge"})
    assert main.is_bridge({"building": "bridge"})
    assert not main.is_bridge({"bridge": "no", "highway": "residential"})
    assert not main.is_bridge({"building": "yes"})
    # a bridge tag on a way with no road/rail class is not a carried deck
    assert not main.is_bridge({"bridge": "yes"})
    assert main.is_tunnel({"tunnel": "yes"})
    assert not main.is_tunnel({"tunnel": "no"})
    # a drain and an arcade are not the road tunnels the user means
    assert not main.is_tunnel({"tunnel": "culvert"})
    assert not main.is_tunnel({"tunnel": "building_passage"})
    assert not main.is_tunnel({})


def test_transport_class_prefers_highway_then_railway():
    assert main.transport_class({"highway": "primary"}) == "primary"
    assert main.transport_class({"railway": "rail"}) == "rail"
    assert main.transport_class({}) is None


def test_to_bridge_clips_a_line_and_carries_the_class():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    cy = (min_lat + max_lat) / 2
    line = shapely.LineString([(min_lon - 0.001, cy), (max_lon + 0.001, cy)])
    f = main.to_bridge(
        1, {"bridge": "yes", "highway": "primary", "layer": "1"}, line, box
    )
    assert f is not None
    assert f["properties"]["cmtype"] == "bridge"
    assert f["properties"]["class"] == "primary"
    assert f["properties"]["bridge"] == "yes"
    assert f["properties"]["layer"] == 1
    clipped = shapely.from_geojson(json.dumps(f["geometry"]))
    assert clipped.geom_type == "LineString"
    assert round(clipped.bounds[0], 9) == round(min_lon, 9)


def test_to_bridge_accepts_a_deck_polygon_and_defaults_its_value():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    cx = (min_lon + max_lon) / 2
    cy = (min_lat + max_lat) / 2
    deck = shapely.box(cx - 1e-4, cy - 1e-4, cx + 1e-4, cy + 1e-4)
    f = main.to_bridge(2, {"man_made": "bridge"}, deck, box)
    assert f is not None
    assert f["properties"]["cmtype"] == "bridge"
    # a footprint with no `bridge` value still names itself
    assert f["properties"]["bridge"] == "deck"
    # and no class: the footprint is not a carried way
    assert "class" not in f["properties"]
    clipped = shapely.from_geojson(json.dumps(f["geometry"]))
    assert clipped.geom_type == "Polygon"


def test_to_tunnel_emits_a_portal_only_at_an_inside_end():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    cy = (min_lat + max_lat) / 2
    cx = (min_lon + max_lon) / 2
    # one end inside the tile, the other outside: exactly one portal
    line = shapely.LineString([(cx, cy), (max_lon + 0.005, cy)])
    portals = main.tunnel_portals(line, box)
    assert len(portals) == 1
    point, angle = portals[0]
    assert point.equals(shapely.Point(cx, cy))
    assert round(angle, 6) == 0.0  # the neighbour is due east
    # both ends inside -> two portals
    inside = shapely.LineString([(cx, cy), (cx + 1e-4, cy)])
    assert len(main.tunnel_portals(inside, box)) == 2
    # the tunnel merely passes under the tile -> nothing
    under = shapely.LineString([(min_lon - 0.005, cy), (max_lon + 0.005, cy)])
    assert main.tunnel_portals(under, box) == []


def test_to_tunnel_features_carry_layer_and_angle():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    cx = (min_lon + max_lon) / 2
    cy = (min_lat + max_lat) / 2
    line = shapely.LineString([(cx, cy), (cx + 1e-4, cy + 1e-4)])
    features = main.to_tunnel(
        3, {"tunnel": "yes", "railway": "rail", "layer": "-1"}, line, box
    )
    assert len(features) == 2
    assert all(f["properties"]["cmtype"] == "tunnel" for f in features)
    assert all(f["properties"]["class"] == "rail" for f in features)
    assert all(f["properties"]["layer"] == -1 for f in features)
    assert all("angle" in f["properties"] for f in features)


def test_tile_to_geojson_routes_building_bridge_to_a_deck():
    # building=bridge used to get a full house treatment; now it is a bridge
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    cx = (min_lon + max_lon) / 2
    cy = (min_lat + max_lat) / 2
    deck = shapely.to_wkb(shapely.box(cx - 1e-4, cy - 1e-4, cx + 1e-4, cy + 1e-4))
    render, _raw = main.tile_to_geojson(
        [(1, {"building": "bridge"}, deck)], 17220, 11723, 15
    )
    assert [f["properties"]["cmtype"] for f in render] == ["bridge"]


def test_tile_to_geojson_keeps_a_normal_building():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    cx = (min_lon + max_lon) / 2
    cy = (min_lat + max_lat) / 2
    building = shapely.to_wkb(shapely.box(cx - 1e-4, cy - 1e-4, cx + 1e-4, cy + 1e-4))
    render, _raw = main.tile_to_geojson(
        [(1, {"building": "yes"}, building)], 17220, 11723, 15
    )
    assert [f["properties"]["cmtype"] for f in render] == ["building"]


def test_to_tunnel_skips_pedestrian_underpasses():
    # a footway underpass is technically a tunnel but not the one the user means
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    cx = (min_lon + max_lon) / 2
    cy = (min_lat + max_lat) / 2
    line = shapely.LineString([(cx, cy), (cx + 1e-4, cy)])
    assert main.to_tunnel(4, {"tunnel": "yes", "highway": "footway"}, line, box) == []
    assert main.to_tunnel(5, {"tunnel": "yes", "highway": "steps"}, line, box) == []


def test_tile_to_geojson_keeps_a_culverted_river_as_water():
    # a buried waterway carries tunnel=yes but is not a road tunnel: it must
    # still be drawn as water, not dropped or turned into a portal
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    cy = (min_lat + max_lat) / 2
    river = shapely.to_wkb(
        geom(f"LINESTRING ({min_lon - 0.001} {cy}, {max_lon + 0.001} {cy})")
    )
    render, _raw = main.tile_to_geojson(
        [(1, {"waterway": "river", "tunnel": "yes", "layer": "-2"}, river)],
        17220,
        11723,
        15,
    )
    assert [f["properties"]["cmtype"] for f in render] == ["water"]
    assert render[0]["properties"]["water"] == "river"


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
