import json

import duckdb
import shapely
from shapely.geometry.base import BaseGeometry

import geo
import impute
import main
import pipeline
import traffic

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


def test_to_building_marks_the_roof_flat_for_solar_panels():
    f = main.to_building(
        42,
        {"building": "yes", "height": "10", "roof:shape": "pyramidal"},
        geom(POLYGON),
        solar_buildings={"42"},
    )
    assert f is not None
    assert f["properties"]["solar"] is True
    other = main.to_building(
        43, {"building": "yes", "height": "10"}, geom(POLYGON), solar_buildings={"42"}
    )
    assert other is not None
    assert "solar" not in other["properties"]


def test_to_building_part_uses_min_height_and_levels():
    f = main.to_building(
        "way/766529419",
        {
            "building:part": "yes",
            "height": "15",
            "min_height": "10",
            "min_level": "2",
            "max_level": "4",
        },
        geom(POLYGON),
    )
    assert f is not None
    assert f["properties"]["base"] == 10.0
    assert f["properties"]["height"] == 15.0

    levels = main.to_building(
        20,
        {"building:part": "yes", "min_level": "2", "max_level": "5"},
        geom(POLYGON),
    )
    assert levels is not None
    assert levels["properties"]["base"] == 6.0
    assert levels["properties"]["height"] == 15.0


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


def test_crosswalk_carries_the_road_bearing_and_width():
    roads = {9: main.RoadData(bearing=90.0, width=7.5)}
    f = main.to_crosswalk(
        9,
        {"highway": "crossing", "crossing": "marked"},
        geom("POINT (9.18 45.5)"),
        roads,
    )
    assert f is not None
    assert f["properties"]["cmtype"] == "crosswalk"
    assert f["properties"]["bearing"] == 90.0
    assert f["properties"]["width"] == 7.5
    # no road match or an unmarked crossing means no zebra
    assert (
        main.to_crosswalk(
            11,
            {"highway": "crossing", "crossing": "marked"},
            geom("POINT (9.18 45.5)"),
            roads,
        )
        is None
    )
    assert (
        main.to_crosswalk(
            9,
            {"highway": "crossing", "crossing": "unmarked"},
            geom("POINT (9.18 45.5)"),
            roads,
        )
        is None
    )


def test_a_pitch_carries_its_surface_so_the_court_can_be_tinted():
    tile_box = shapely.box(9.0, 45.0, 9.01, 45.01)
    pitch = geom(
        "POLYGON ((9.0 45.0, 9.004 45.0, 9.004 45.0025, 9.0 45.0025, 9.0 45.0))"
    )

    clay = main.to_green(
        "way/1",
        {"leisure": "pitch", "sport": "tennis", "surface": "Clay"},
        pitch,
        tile_box,
    )
    assert clay is not None
    # raw and lowercased: the frontend owns the colour table, not tilegen
    assert clay["properties"]["surface"] == "clay"

    # a running track has a surface too (tartan is the usual one)
    track_box = shapely.box(9.0, 45.0, 9.01, 45.01)
    track = geom("POLYGON ((9.0 45.0, 9.008 45.0, 9.008 45.004, 9.0 45.004, 9.0 45.0))")
    tartan = main.to_green(
        "way/2",
        {"leisure": "track", "sport": "athletics", "surface": "tartan"},
        track,
        track_box,
    )
    assert tartan is not None
    assert tartan["properties"]["surface"] == "tartan"

    # parks and untagged pitches have nothing to tint
    park = main.to_green(
        "way/3", {"leisure": "park", "surface": "grass"}, pitch, tile_box
    )
    assert park is not None
    assert "surface" not in park["properties"]


def test_a_pitch_carries_its_sport_for_the_frontend_to_paint():
    tile_box = shapely.box(9.0, 45.0, 9.01, 45.01)
    pitch = geom(
        "POLYGON ((9.0 45.0, 9.004 45.0, 9.004 45.0025, 9.0 45.0025, 9.0 45.0))"
    )

    f = main.to_green("way/1", {"leisure": "pitch", "sport": "soccer"}, pitch, tile_box)
    assert f is not None
    # still a green area: the sport rides along, the paint is frontend-side
    assert f["properties"]["cmtype"] == "green"
    assert f["properties"]["green"] == "grass"
    assert f["properties"]["sport"] == "soccer"

    # a ";" list travels whole; the frontend picks the entry it can paint
    multi = main.to_green(
        "way/2", {"leisure": "pitch", "sport": "Soccer;Tennis"}, pitch, tile_box
    )
    assert multi is not None
    assert multi["properties"]["sport"] == "soccer;tennis"

    # not a pitch, or a pitch with no sport: no field at all
    park = main.to_green("way/3", {"leisure": "park"}, pitch, tile_box)
    assert park is not None
    assert "sport" not in park["properties"]
    untagged = main.to_green("way/4", {"leisure": "pitch"}, pitch, tile_box)
    assert untagged is not None
    assert "sport" not in untagged["properties"]


def test_a_running_track_is_green_ground_with_an_athletics_oval():
    tile_box = shapely.box(9.0, 45.0, 9.01, 45.01)
    oval = geom("POLYGON ((9.0 45.0, 9.008 45.0, 9.008 45.004, 9.0 45.004, 9.0 45.0))")

    # leisure=track with a running sport: green ground, painted as athletics
    track = main.to_green(
        "way/1", {"leisure": "track", "sport": "athletics"}, oval, tile_box
    )
    assert track is not None
    assert track["properties"]["cmtype"] == "green"
    assert track["properties"]["green"] == "track"
    assert track["properties"]["sport"] == "athletics"

    # sport=running is the same oval on the ground
    running = main.to_green(
        "way/2", {"leisure": "track", "sport": "running"}, oval, tile_box
    )
    assert running is not None
    assert running["properties"]["sport"] == "athletics"

    # a velodrome or a karting circuit is not green ground, and not painted
    for other in ("cycling", "karting", "horse_racing", None):
        tags = (
            {"leisure": "track"}
            if other is None
            else {"leisure": "track", "sport": other}
        )
        assert main.to_green("way/3", tags, oval, tile_box) is None
        assert not main.is_green(tags)


def test_a_way_under_something_is_flagged_for_hiding():
    # a tunnel, a covered section or anything mapped below ground hides its
    # vehicles; building passages draw no portal but are under a building
    assert main.runs_underground({"tunnel": "yes"})
    assert main.runs_underground({"tunnel": "building_passage"})
    assert main.runs_underground({"covered": "yes"})
    assert main.runs_underground({"layer": "-1"})
    assert not main.runs_underground({"tunnel": "no"})
    assert not main.runs_underground({"tunnel": "culvert"})
    assert not main.runs_underground({"layer": "1"})
    assert not main.runs_underground({"bridge": "yes"})


def test_a_shape_snaps_to_the_nearest_line_of_its_network():
    from shapely.geometry import LineString

    from loaders import route_network

    surface = (LineString([(9.0, 45.0), (9.01, 45.0)]), False)
    tunnel = (LineString([(9.0, 45.001), (9.01, 45.001)]), True)
    network = route_network([surface, tunnel])

    # five meters off the tunnel line: the offset does not matter, the way it
    # follows does
    assert main.snap_underground(network, [(9.005, 45.00095)]) == [True]
    # the same shape over the surface line
    assert main.snap_underground(network, [(9.005, 45.0)]) == [False]
    # far from both networks: nothing to inherit
    assert main.snap_underground(network, [(9.005, 45.02)]) == [False]
    assert main.snap_underground(route_network([]), [(9.005, 45.0)]) == [False]


def test_lane_features_carry_width_lanes_and_direction():
    tile_box = shapely.box(9.0, 45.0, 9.01, 45.01)
    road = geom("LINESTRING (9.0 45.0, 9.02 45.02)")

    two_way = main.to_lane(
        "way/1", {"highway": "residential", "lanes": "2"}, road, tile_box
    )
    assert two_way is not None
    assert two_way["properties"]["cmtype"] == "lane"
    assert two_way["properties"]["lanes"] == 2
    assert two_way["properties"]["oneway"] is False
    # two lanes and no width tag: 2 * 3.25 m plus a metre of shoulder
    assert two_way["properties"]["width"] == 7.5
    # clipped to the tile, like water: a road spans many tiles
    assert two_way["geometry"]["type"] == "LineString"
    clipped = shapely.from_geojson(json.dumps(two_way["geometry"]))
    assert clipped.within(tile_box)

    tagged = main.to_lane(
        "way/2",
        {"highway": "primary", "lanes": "6", "oneway": "yes", "width": "18"},
        road,
        tile_box,
    )
    assert tagged is not None
    assert tagged["properties"]["lanes"] == 6
    assert tagged["properties"]["oneway"] is True
    assert tagged["properties"]["width"] == 18.0

    # one lane has nothing to divide; a service way carries no paint; a plaza
    # mapped as a highway area is not a lane
    assert (
        main.to_lane("way/3", {"highway": "residential", "lanes": "1"}, road, tile_box)
        is None
    )
    assert (
        main.to_lane("way/4", {"highway": "service", "lanes": "4"}, road, tile_box)
        is None
    )
    assert (
        main.to_lane("way/5", {"highway": "residential", "area": "yes"}, road, tile_box)
        is None
    )
    # lanes are inferred from the width when the tag is missing
    wide = main.to_lane("way/6", {"highway": "secondary"}, road, tile_box)
    assert wide is not None
    assert wide["properties"]["lanes"] == 3  # 10 m / 3.25


def test_road_markings_carry_directions_and_lanes():
    roads = {
        20: main.RoadData(
            bearing=90.0, width=12.0, lanes=4, oneway="yes", turn_lanes="left|through"
        ),
        21: main.RoadData(bearing=90.0, width=8.0, lanes=1, oneway=None),
    }
    signal = main.to_road_marking(
        20, {"highway": "traffic_signals"}, geom("POINT (9.18 45.5)"), roads
    )
    assert signal is not None
    assert signal["properties"]["cmtype"] == "road_marking"
    assert signal["properties"]["kind"] == "signal"
    assert signal["properties"]["directions"] == [90.0]
    assert signal["properties"]["lanes"] == 4
    assert signal["properties"]["turn_lanes"] == "left|through"

    two_way = main.to_road_marking(
        21, {"highway": "traffic_signals"}, geom("POINT (9.18 45.5)"), roads
    )
    assert two_way is not None
    assert two_way["properties"]["directions"] == [90.0, 270.0]

    backward = main.to_road_marking(
        21,
        {"highway": "stop", "direction": "backward"},
        geom("POINT (9.18 45.5)"),
        roads,
    )
    assert backward is not None
    assert backward["properties"]["directions"] == [270.0]
    assert backward["properties"]["kind"] == "stop"

    assert (
        main.to_road_marking(99, {"highway": "stop"}, geom("POINT (9.18 45.5)"), roads)
        is None
    )


def test_parse_lane_count_falls_back_to_width():
    assert main.parse_lane_count({"lanes": "3"}, 7.0) == 3
    assert main.parse_lane_count({}, 7.0) == 2
    assert main.parse_lane_count({}, 2.0) == 1


def test_crossing_markings_and_road_width():
    assert main.crossing_is_marked({"crossing": "unmarked"}) is False
    assert main.crossing_is_marked({"crossing": "informal"}) is False
    assert main.crossing_is_marked({"crossing": "uncontrolled"}) is True
    assert main.crossing_is_marked({"crossing:markings": "zebra"}) is True
    assert main.crossing_is_marked({"crossing:markings": "dots"}) is False
    assert (
        main.crossing_is_marked({"crossing": "unmarked", "crossing:markings": "yes"})
        is False
    )
    assert main.road_width({"highway": "residential"}) == 7.0
    assert main.road_width({"highway": "residential", "width": "8.5 m"}) == 8.5
    assert main.road_width({"highway": "primary", "lanes": "2"}) == 7.5
    assert main.road_width({"highway": "primary", "lanes": "2;3"}) == 7.5


def test_way_bearing_north_and_east():
    north = shapely.LineString([(9.18, 45.5), (9.18, 45.51)])
    east = shapely.LineString([(9.18, 45.5), (9.19, 45.5)])
    assert main.way_bearing(north, shapely.Point(9.18, 45.505)) == 0.0
    assert main.way_bearing(east, shapely.Point(9.185, 45.5)) == 90.0
    # a 45-degree line in raw lon/lat is only ~35 degrees in model meters
    diagonal = shapely.LineString([(9.18, 45.5), (9.19, 45.51)])
    assert abs(main.way_bearing(diagonal, shapely.Point(9.185, 45.505)) - 35.0) < 0.5


def test_way_bearing_uses_the_segment_at_a_vertex():
    bent = shapely.LineString([(9.18, 45.5), (9.18, 45.51), (9.19, 45.51)])
    # the chord across the bend would be 45 degrees; the segment is north or east
    assert main.way_bearing(bent, shapely.Point(9.18, 45.51)) in (0.0, 90.0)


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


def test_to_bench_keeps_osm_colours():
    f = main.to_bench(
        16,
        {"amenity": "bench", "colour": "green", "color": "#123456"},
        geom("POINT (9.18 45.5)"),
    )
    assert f is not None
    # both spellings travel to the frontend, which validates them
    assert f["properties"] == {
        "cmtype": "bench",
        "colour": "green",
        "color": "#123456",
    }


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


def test_rail_clips_and_skips_tunnels_and_bridges():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    line = shapely.LineString(
        [(min_lon - 0.001, min_lat + 0.001), (max_lon + 0.001, max_lat - 0.001)]
    )
    f = main.to_rail(1, {"railway": "rail"}, line, box)
    assert f is not None
    assert f["properties"]["cmtype"] == "rail"
    assert f["properties"]["kind"] == "rail"
    assert main.to_rail(2, {"railway": "rail", "tunnel": "yes"}, line, box) is None
    assert main.to_rail(3, {"railway": "rail", "bridge": "yes"}, line, box) is None
    assert main.to_rail(4, {"railway": "rail", "layer": "1"}, line, box) is None


def test_platform_polygons_and_line_platforms():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    polygon = shapely.box(
        min_lon + 0.0001, min_lat + 0.0001, min_lon + 0.0003, min_lat + 0.0005
    )
    platform = main.to_platform(
        5,
        {"public_transport": "platform", "train": "yes", "name": "Binario 1"},
        polygon,
        box,
    )
    assert platform is not None
    assert platform["properties"]["cmtype"] == "platform"
    assert platform["properties"]["name"] == "Binario 1"
    line = shapely.LineString(
        [(min_lon + 0.0001, min_lat + 0.0001), (min_lon + 0.0003, min_lat + 0.0003)]
    )
    buffered = main.to_platform(6, {"railway": "platform", "tram": "yes"}, line, box)
    assert buffered is not None
    assert buffered["geometry"]["type"] in ("Polygon", "MultiPolygon")
    assert (
        main.to_platform(
            7, {"public_transport": "platform", "bus": "yes"}, polygon, box
        )
        is None
    )


def test_parking_rows_are_clipped_to_each_tile():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    row = main.ParkingRow(
        id="way/1:+",
        coords=[(min_lon - 0.001, min_lat + 0.001), (max_lon + 0.001, max_lat - 0.001)],
        style="parallel",
        pitch=5.0,
        side=1,
    )
    by_tile = main.parking_rows_by_tile([row], 15)
    assert by_tile
    for rows in by_tile.values():
        for part in rows:
            assert part["id"] == "way/1:+"
            assert part["style"] == "parallel"
            assert part["pitch"] == 5.0
            assert part["side"] == 1
            assert len(part["coords"]) >= 2


def test_sidewalk_polygons_are_clipped_to_each_tile():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    mid_lat = (min_lat + max_lat) / 2
    line = main.SidewalkLine(
        id="way/1:L",
        coords=[
            (min_lon + 0.0001, mid_lat + 0.0003),
            (max_lon - 0.0001, mid_lat + 0.0003),
        ],
        width=2.2,
        side=1,
    )
    road = main.ParkingWay(
        id="way/9",
        coords=[
            (min_lon + 0.0002, mid_lat - 0.0005),
            (max_lon - 0.0002, mid_lat - 0.0005),
        ],
        highway="residential",
    )
    by_tile = main.sidewalk_polygons_by_tile([line], [road], 15)
    assert by_tile
    for features in by_tile.values():
        assert len(features) == 1
        assert features[0]["properties"]["cmtype"] == "sidewalk"
        assert features[0]["geometry"]["type"] in ("Polygon", "MultiPolygon")


def test_walls_and_gates_keep_their_data():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    wall = shapely.LineString(
        [(min_lon + 0.0001, min_lat + 0.0001), (min_lon + 0.0004, min_lat + 0.0001)]
    )
    f = main.to_wall(1, {"barrier": "wall", "wall": "brick", "height": "2"}, wall, box)
    assert f is not None
    assert f["properties"]["cmtype"] == "wall"
    assert f["properties"]["wall"] == "brick"
    gate = main.to_gate(
        2,
        {"barrier": "gate"},
        shapely.Point(min_lon + 0.0002, min_lat + 0.0001),
        {2: 90.0},
    )
    assert gate is not None
    assert gate["properties"]["cmtype"] == "gate"
    assert gate["properties"]["bearing"] == 90.0
    assert (
        main.to_gate(3, {"barrier": "gate"}, shapely.Point(min_lon, min_lat), {})
        is None
    )


def test_park_path_is_clipped_to_green_and_classified():
    green = shapely.box(9.0, 45.0, 9.01, 45.01)
    tile_box = shapely.box(9.0, 45.0, 9.01, 45.01)
    path = shapely.LineString([(8.99, 45.005), (9.02, 45.005)])
    walk = main.to_park_path("way/1", {"highway": "footway"}, path, green, tile_box)
    assert walk is not None
    assert walk["properties"]["kind"] == "walk"
    assert walk["geometry"]["type"] == "LineString"
    bike = main.to_park_path(
        "way/2",
        {"highway": "path", "bicycle": "designated", "surface": "asphalt"},
        path,
        green,
        tile_box,
    )
    assert bike is not None
    assert bike["properties"]["kind"] == "bike"
    assert bike["properties"]["surface"] == "asphalt"
    assert (
        main.to_park_path(
            "way/3",
            {"highway": "footway", "footway": "sidewalk"},
            path,
            green,
            tile_box,
        )
        is None
    )
    assert (
        main.to_park_path(
            "way/4",
            {"highway": "footway"},
            shapely.LineString([(8.9, 45.2), (8.92, 45.2)]),
            green,
            tile_box,
        )
        is None
    )


def test_power_tower_and_line_are_emitted():
    tower = main.to_power_tower("node/1", {"power": "tower"}, shapely.Point(9.0, 45.0))
    assert tower is not None
    assert tower["properties"]["cmtype"] == "power_tower"
    assert tower["properties"]["height"] == 30.0
    tile_box = shapely.box(9.0, 45.0, 9.01, 45.01)
    line = shapely.LineString([(8.99, 45.005), (9.02, 45.005)])
    features = main.to_power_line(
        "way/2", {"power": "line", "voltage": "380000"}, line, tile_box
    )
    assert len(features) == 1
    assert features[0]["properties"]["cmtype"] == "power_line"
    assert features[0]["properties"]["height"] == 26.0
    assert features[0]["geometry"]["type"] == "LineString"
    assert (
        main.to_power_line(
            "way/3", {"power": "line", "location": "underground"}, line, tile_box
        )
        == []
    )


def test_rooftop_kind_maps_the_supported_tags():
    assert main.rooftop_kind({"man_made": "water_tower"}) == "water_tower"
    assert main.rooftop_kind({"man_made": "chimney"}) == "chimney"
    assert main.rooftop_kind({"man_made": "mast"}) == "antenna"
    assert main.rooftop_kind({"generator:source": "solar"}) == "solar"
    assert main.rooftop_kind({"man_made": "bench"}) is None


def test_load_rooftop_accessories_marks_the_solar_building(tmp_path):
    duckdb.load_extension("spatial")
    path = tmp_path / "rooftops.parquet"
    con = duckdb.connect()
    con.execute(
        "create table t(feature_id bigint, tags map(varchar,varchar), geometry geometry)"
    )
    con.execute(
        "insert into t values (1, map(['building','height'],['yes','12']), ST_GeomFromWKB(?))",
        [shapely.to_wkb(shapely.box(9.0, 45.0, 9.001, 45.001))],
    )
    con.execute(
        "insert into t values (2, map(['generator:source'],['solar']), ST_GeomFromWKB(?))",
        [shapely.to_wkb(shapely.box(9.0002, 45.0002, 9.0008, 45.0008))],
    )
    con.execute(
        "insert into t values (3, map(['man_made'],['water_tower']), ST_GeomFromWKB(?))",
        [shapely.to_wkb(shapely.Point(9.0005, 45.0005))],
    )
    con.execute(f"copy t to '{path}' (format parquet)")
    by_tile, solar_buildings = main.load_rooftop_accessories(path)
    assert solar_buildings == {"1"}
    assert sum(len(features) for features in by_tile.values()) == 2


def test_rooftop_feature_lifts_a_water_tower_to_the_building_roof():
    building = shapely.box(9.0, 45.0, 9.001, 45.001)
    buildings = [building]
    tags = [{"building": "yes", "height": "12"}]
    tree = shapely.STRtree(buildings)
    f = main.rooftop_feature(
        "node/1",
        {"man_made": "water_tower"},
        shapely.Point(9.0005, 45.0005),
        buildings,
        tags,
        tree,
    )
    assert f is not None
    assert f["properties"]["base"] == 12.0
    assert f["properties"]["kind"] == "water_tower"
    assert f["properties"]["height"] == 8.0
    outside = main.rooftop_feature(
        "node/2",
        {"man_made": "chimney"},
        shapely.Point(9.1, 45.1),
        buildings,
        tags,
        tree,
    )
    assert outside is not None
    assert outside["properties"]["base"] == 0.0
    level_building = [shapely.box(9.0, 45.0, 9.001, 45.001)]
    level_tags = [{"building": "yes", "building:levels": "4"}]
    level_tree = shapely.STRtree(level_building)
    levels = main.rooftop_feature(
        "node/2b",
        {"man_made": "antenna"},
        shapely.Point(9.0005, 45.0005),
        level_building,
        level_tags,
        level_tree,
    )
    assert levels is not None
    assert levels["properties"]["base"] == 12.0
    part_building = [shapely.box(9.0, 45.0, 9.001, 45.001)]
    part_tags = [{"building:part": "yes", "min_height": "10", "building:levels": "2"}]
    part_tree = shapely.STRtree(part_building)
    part = main.rooftop_feature(
        "node/2c",
        {"man_made": "antenna"},
        shapely.Point(9.0005, 45.0005),
        part_building,
        part_tags,
        part_tree,
    )
    assert part is not None
    assert part["properties"]["base"] == 16.0
    solar = main.rooftop_feature(
        "node/3",
        {"generator:source": "solar"},
        shapely.box(9.0002, 45.0002, 9.0008, 45.0008),
        buildings,
        tags,
        tree,
    )
    assert solar is not None
    assert solar["properties"]["base"] == 12.0
    assert solar["properties"]["height"] == 0.4
    assert solar["geometry"]["type"] == "Polygon"
    chimney = main.rooftop_feature(
        "node/4",
        {"man_made": "chimney", "height": "20"},
        shapely.Point(9.0005, 45.0005),
        buildings,
        tags,
        tree,
    )
    assert chimney is not None
    assert chimney["properties"]["height"] == 8.0
    assert (
        main.rooftop_feature(
            "node/5",
            {"man_made": "water_tower"},
            shapely.LineString([(9.0, 45.0), (9.001, 45.001)]),
            buildings,
            tags,
            tree,
        )
        is None
    )
    assert (
        main.rooftop_feature(
            "node/6",
            {"man_made": "bench"},
            shapely.Point(9.0, 45.0),
            buildings,
            tags,
            tree,
        )
        is None
    )


def test_wall_polygon_uses_its_boundary():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    area = shapely.box(
        min_lon + 0.0001, min_lat + 0.0001, min_lon + 0.0003, min_lat + 0.0003
    )
    f = main.to_wall(1, {"barrier": "wall"}, area, box)
    assert f is not None
    assert f["geometry"]["type"] == "LineString"


def test_construction_is_clipped_and_marks_the_crane_tile():
    min_lon, min_lat, max_lon, max_lat = geo.tile_lonlat_bounds(17220, 11723, 15)
    box = shapely.box(min_lon, min_lat, max_lon, max_lat)
    site = shapely.box(min_lon - 1, min_lat - 1, max_lon + 1, max_lat + 1)
    f = main.to_construction(
        1, {"landuse": "construction", "construction": "commercial"}, site, box
    )
    assert f is not None
    assert f["properties"]["cmtype"] == "construction"
    assert f["properties"]["construction"] == "commercial"
    assert f["properties"]["crane"] is True
    clipped = shapely.from_geojson(json.dumps(f["geometry"]))
    assert clipped.equals(box)
    away = shapely.box(max_lon + 0.01, max_lat + 0.01, max_lon + 0.02, max_lat + 0.02)
    part = main.to_construction(2, {"landuse": "construction"}, away, box)
    assert part is None


def test_playgrounds_and_monuments_carry_kind_and_name():
    point = shapely.Point(9.19, 45.46)
    playground = main.to_playground(
        1, {"leisure": "playground", "name": "Giochi"}, point
    )
    assert playground is not None
    assert playground["properties"] == {
        "cmtype": "playground",
        "size": 10.0,
        "name": "Giochi",
    }

    statue = main.to_monument(
        2,
        {"historic": "memorial", "memorial": "statue", "name": "Eroe"},
        point,
    )
    assert statue is not None
    assert statue["properties"] == {
        "cmtype": "monument",
        "kind": "memorial",
        "memorial": "statue",
        "name": "Eroe",
    }
    obelisk = main.to_monument(3, {"man_made": "obelisk"}, point)
    assert obelisk is not None
    assert obelisk["properties"]["kind"] == "obelisk"
    assert main.to_monument(4, {"historic": "castle"}, point) is None


def test_to_playground_sizes_a_mapped_area():
    area = shapely.box(9.19, 45.46, 9.1902, 45.4602)
    playground = main.to_playground(5, {"leisure": "playground"}, area)
    assert playground is not None
    assert 6 <= playground["properties"]["size"] <= 18
    assert playground["geometry"]["type"] == "Point"


def test_is_terrace_accepts_food_places_but_not_off():
    assert main.is_terrace({"amenity": "cafe", "outdoor_seating": "yes"})
    assert main.is_terrace({"amenity": "restaurant", "outdoor_seating": "sidewalk"})
    assert not main.is_terrace({"amenity": "cafe", "outdoor_seating": "no"})
    assert not main.is_terrace({"amenity": "pharmacy", "outdoor_seating": "yes"})
    assert not main.is_terrace({"amenity": "cafe"})


def test_terrace_place_moves_to_the_kerb_outside_buildings():
    road = shapely.LineString([(0, 0), (10, 0)])
    # the cafe is 10 m north of the road; a building starts 3 m in
    building = shapely.box(0, 3, 10, 10)
    tree = shapely.STRtree([building])
    placed = main.terrace_place(shapely.Point(5, 10), road, tree, [building])
    assert placed.x == 5
    assert placed.y <= 3.0001
    # a wide-open cafe keeps the far offset
    open_placed = main.terrace_place(
        shapely.Point(5, 10), road, shapely.STRtree([]), []
    )
    assert open_placed.x == 5
    assert open_placed.y == 8


def test_to_terrace_keeps_name_and_amenity():
    point = shapely.Point(9.19, 45.46)
    cafe = main.to_terrace(
        1, {"amenity": "cafe", "outdoor_seating": "yes", "name": "Bar"}, point
    )
    assert cafe is not None
    assert cafe["properties"] == {
        "cmtype": "terrace",
        "terrace": "cafe",
        "name": "Bar",
    }
    plain = main.to_terrace(2, {"amenity": "bar", "outdoor_seating": "yes"}, point)
    assert plain is not None
    assert "name" not in plain["properties"]
    assert main.to_terrace(3, {"amenity": "cafe"}, point) is None
    placed = main.to_terrace(
        4,
        {"amenity": "cafe", "outdoor_seating": "yes"},
        point,
        (9.2, 45.47),
    )
    assert placed is not None
    assert placed["geometry"]["coordinates"] == [9.2, 45.47]


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

    monkeypatch.setattr(pipeline, "build_fleets", counting_build)

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

    monkeypatch.setattr(pipeline, "build_fleets", counting_build)

    main.load_or_build_fleets(ways, configs, tmp_path, use_cache=False)
    main.load_or_build_fleets(ways, configs, tmp_path, use_cache=False)
    assert calls["n"] == 2
    assert not list(tmp_path.iterdir())  # nothing was cached
