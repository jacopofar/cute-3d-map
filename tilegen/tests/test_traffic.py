import json
import math
from itertools import pairwise

import pytest

import geo
import traffic
from traffic import TrafficConfig, Way


def square_ways(lon, lat, d, oneway=None, reverse=False):
    """Four ways forming a closed square centred on (lon, lat)."""
    corners = [
        (lon - d, lat - d),
        (lon + d, lat - d),
        (lon + d, lat + d),
        (lon - d, lat + d),
    ]
    if reverse:
        corners = list(reversed(corners))
    ways = []
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        ways.append(Way([a, b], oneway=oneway, highway="residential"))
    return ways


def grid_ways(n=8, d=0.001, lon=9.18, lat=45.5):
    """An n x n grid of two-way streets, for the random-loop generator."""

    def point(i, j):
        return (lon + i * d, lat + j * d)

    ways = []
    for i in range(n):
        for j in range(n):
            if i + 1 < n:
                ways.append(Way([point(i, j), point(i + 1, j)], highway="residential"))
            if j + 1 < n:
                ways.append(Way([point(i, j), point(i, j + 1)], highway="residential"))
    return ways


def segs_to_coords(loop):
    coords = []
    for seg in loop.segs:
        if coords and coords[-1] == seg[0]:
            coords.extend(seg[1:])
        else:
            coords.extend(seg)
    return coords


def signed_area(coords):
    lat0 = sum(c[1] for c in coords) / len(coords)
    cos = math.cos(math.radians(lat0))
    area = 0.0
    for (x1, y1), (x2, y2) in zip(coords, coords[1:] + coords[:1]):
        area += (x1 * cos) * y2 - (x2 * cos) * y1
    return area / 2


def find(ways, config=None):
    graph = traffic.build_graph(ways)
    loops = traffic.find_loops(graph, config or TrafficConfig())
    return graph, loops


def test_single_square_is_one_loop():
    _, loops = find(square_ways(9.18, 45.5, 0.001))
    assert len(loops) == 1
    loop = loops[0]
    corners = [
        (9.179, 45.499),
        (9.181, 45.499),
        (9.181, 45.501),
        (9.179, 45.501),
    ]
    expected = sum(
        traffic.haversine_m(a, b) for a, b in zip(corners, corners[1:] + corners[:1])
    )
    assert loop.length == pytest.approx(expected, rel=0.01)
    # the planar interior face winds counter-clockwise (positive area)
    assert signed_area(segs_to_coords(loop)) > 0


def test_two_squares_sharing_an_edge_are_two_loops():
    lon, lat, d = 9.18, 45.5, 0.001
    corners = [
        (lon - d, lat - d),
        (lon, lat - d),
        (lon + d, lat - d),
        (lon + d, lat + d),
        (lon, lat + d),
        (lon - d, lat + d),
    ]
    ways = []
    for i in range(6):
        ways.append(Way([corners[i], corners[(i + 1) % 6]], highway="residential"))
    ways.append(Way([corners[1], corners[4]], highway="residential"))  # shared edge
    _, loops = find(ways)
    assert len(loops) == 2


def test_dangling_edge_is_not_a_loop():
    ways = square_ways(9.18, 45.5, 0.001)
    ways.append(Way([(9.18, 45.5), (9.20, 45.5)], highway="residential"))
    _, loops = find(ways)
    assert len(loops) == 1


def test_dual_carriageway_sliver_is_dropped():
    # ~780 m long, ~0.8 m wide: a median, not a block
    lon, lat = 9.18, 45.5
    length, width = 0.01, 1e-5
    corners = [
        (lon, lat),
        (lon + length, lat),
        (lon + length, lat + width),
        (lon, lat + width),
    ]
    ways = [
        Way([corners[i], corners[(i + 1) % 4]], highway="primary") for i in range(4)
    ]
    _, loops = find(ways)
    assert loops == []


def test_short_loop_is_dropped():
    _, loops = find(square_ways(9.18, 45.5, 0.00005))  # ~38 m perimeter
    assert loops == []


def test_oneway_loop_is_oriented_along_the_legal_direction():
    # ways point clockwise; the legal traversal is the reverse of the planar
    # (counter-clockwise) face
    ways = square_ways(9.18, 45.5, 0.001, oneway="yes", reverse=True)
    _, loops = find(ways)
    assert len(loops) == 1
    assert signed_area(segs_to_coords(loops[0])) < 0


def test_oneway_loop_with_no_legal_direction_is_dropped():
    # a cycle of one-way edges that all point the same way is not traversable
    lon, lat, d = 9.18, 45.5, 0.001
    corners = [
        (lon - d, lat - d),
        (lon + d, lat - d),
        (lon + d, lat + d),
        (lon - d, lat + d),
    ]
    # every edge points counter-clockwise, but as separate one-way ways the
    # walk around the square is legal counter-clockwise, so make two edges
    # fight each other instead
    ways = [
        Way([corners[0], corners[1]], oneway="yes"),
        Way([corners[2], corners[1]], oneway="yes"),
        Way([corners[2], corners[3]], oneway="yes"),
        Way([corners[0], corners[3]], oneway="yes"),
    ]
    _, loops = find(ways)
    assert loops == []


def test_assign_vehicles_even_phases_and_period():
    _, loops = find(square_ways(9.18, 45.5, 0.001))
    traffic.assign_vehicles(loops, TrafficConfig(spacing=50.0))
    loop = loops[0]
    n = len(loop.vehicles)
    assert n >= 2
    assert [v["phase"] for v in loop.vehicles] == pytest.approx(
        [k / n for k in range(n)]
    )
    assert loop.period == pytest.approx(loop.length / loop.v)


def test_segment_pieces_split_at_tile_boundary():
    # a tile boundary sits at this longitude
    boundary = geo.tile_lonlat_bounds(17220, 11723, 15)[2]
    p = (boundary - 0.001, 45.5)
    q = (boundary + 0.001, 45.5)
    pieces = traffic.segment_pieces(p, q, 15)
    assert len(pieces) == 2
    assert pieces[0][1] == pytest.approx(pieces[1][0])
    assert pieces[0][1][0] == pytest.approx(boundary)


def test_split_runs_are_contiguous_across_tiles():
    boundary = geo.tile_lonlat_bounds(17220, 11723, 15)[2]
    ways = square_ways(boundary, 45.5, 0.001)
    _graph, loops = find(ways)
    traffic.assign_vehicles(loops, TrafficConfig(spacing=50.0))
    loop = loops[0]
    runs = sorted(traffic.split_runs(loop, 15), key=lambda r: r[1])
    # the square straddles the boundary, so it lands in two tiles
    assert len({tile for tile, *_ in runs}) == 2
    assert runs[0][1] == pytest.approx(0.0)
    assert runs[-1][2] == pytest.approx(loop.period)
    for before, after in pairwise(runs):
        assert before[2] == pytest.approx(after[1])
        # geometry is continuous through the seam
        assert before[3][-1] == after[3][0]
    # the seam closes the loop
    assert runs[-1][3][-1] == runs[0][3][0]


def test_loops_to_tiles_shares_geometry_and_vehicles():
    _, loops = find(square_ways(9.18, 45.5, 0.001))
    traffic.assign_vehicles(loops, TrafficConfig(spacing=50.0))
    by_tile = traffic.loops_to_tiles(loops, 15)
    assert len(by_tile) == 1
    entry = next(iter(by_tile.values()))[0]
    assert entry["id"] == loops[0].id
    assert entry["v"] == pytest.approx(round(loops[0].v, 3))
    assert len(entry["vehicles"]) == len(loops[0].vehicles)
    assert entry["runs"][0]["t0"] == 0.0


def test_scheduled_loop_keeps_stop_dwell():
    loop = traffic.Loop(
        id="gtfs-test",
        segs=[[(9.18, 45.5), (9.181, 45.5)]],
        seg_speeds=[10.0],
        length=78.0,
        period=15.0,
        seg_times=[10.0],
        seg_dwells=[5.0],
        kind="bus",
    )
    runs = traffic.split_runs(loop, 15)
    assert runs
    assert runs[-1][2] == pytest.approx(15.0)
    assert runs[-1][3][-1] == runs[-1][3][-2]


def test_loop_metadata_survives_tiles_and_cache():
    _, loops = find(square_ways(9.18, 45.5, 0.001))
    loops[0].meta = {"line": "1", "type": "tram"}
    traffic.assign_vehicles(loops, TrafficConfig(spacing=50.0))
    entry = next(iter(traffic.loops_to_tiles(loops, 15).values()))[0]
    assert entry["meta"] == {"line": "1", "type": "tram"}
    records = traffic.loops_to_records(loops)
    restored = traffic.loops_from_records(records)
    assert restored[0].meta == {"line": "1", "type": "tram"}


def test_global_budget_raises_spacing():
    ways = square_ways(9.18, 45.5, 0.001)
    _graph, loops = find(ways)
    traffic.assign_vehicles(loops, TrafficConfig(spacing=10.0, max_vehicles=1))
    assert sum(len(loop.vehicles) for loop in loops) == 1


def test_build_traffic_tiles_tags_each_fleet():
    ways_by_kind = {
        "car": square_ways(9.18, 45.5, 0.001),
        "train": square_ways(9.18, 45.5005, 0.001),
    }
    config = TrafficConfig(min_loop_length=80.0, spacing=50.0)
    by_tile = traffic.build_traffic_tiles(
        ways_by_kind, 15, {"car": config, "train": config}
    )
    kinds = {entry["kind"] for entries in by_tile.values() for entry in entries}
    assert kinds == {"car", "train"}


def test_loop_coords_closes_the_ring():
    _, loops = find(square_ways(9.18, 45.5, 0.001))
    coords = traffic.loop_coords(loops[0])
    assert coords[0] == coords[-1]
    assert len(coords) == 5  # four corners plus the closing point


def test_loop_report_and_geojson():
    _, loops = find(square_ways(9.18, 45.5, 0.001))
    traffic.assign_vehicles(loops, TrafficConfig(min_loop_length=80.0, spacing=50.0))
    report = traffic.loop_report({"car": loops, "train": []})
    assert "## car" in report
    assert "Loops: **1**" in report
    assert "## train" in report
    assert "No loops." in report

    features = traffic.loops_to_geojson(loops)
    assert len(features) == 1
    assert features[0]["geometry"]["type"] == "LineString"
    assert features[0]["properties"]["kind"] == "car"
    assert features[0]["properties"]["vehicles"] == len(loops[0].vehicles)


def test_report_and_geojson_include_crossing_points():
    _graph, loops = find(square_ways(9.18, 45.5, 0.001))
    traffic.assign_vehicles(loops, TrafficConfig(min_loop_length=80.0, spacing=50.0))
    points = [
        traffic.CrossingPoint(lon=9.18, lat=45.5, kind="traffic_signal"),
        traffic.CrossingPoint(lon=9.2, lat=45.6, kind="crossing"),
    ]
    report = traffic.loop_report({"car": loops}, points)
    assert "## signals and crossings" in report
    assert "Traffic signals: **1**" in report
    assert "Crossings: **1**" in report

    features = traffic.loops_to_geojson(loops, points)
    geometries = [f["geometry"]["type"] for f in features]
    assert geometries.count("LineString") == 1
    assert geometries.count("Point") == 2
    point_kinds = {
        f["properties"]["kind"] for f in features if f["geometry"]["type"] == "Point"
    }
    assert point_kinds == {"traffic_signal", "crossing"}


def test_loops_to_tiles_has_no_stop_annotations():
    # the generator stores the points only; the per-loop stop list is gone
    _graph, loops = find(square_ways(9.18, 45.5, 0.001))
    traffic.assign_vehicles(loops, TrafficConfig(spacing=50.0))
    entry = next(iter(traffic.loops_to_tiles(loops, 15).values()))[0]
    assert "stops" not in entry
    assert "period_eff" not in entry
    assert not hasattr(loops[0], "stops")


def test_random_loops_are_closed_and_within_bounds():
    graph = traffic.build_graph(grid_ways())
    config = TrafficConfig(
        method="random",
        loop_count=5,
        seed=1,
        min_loop_length=100.0,
        max_loop_length=5000.0,
    )
    loops = traffic.random_loops(graph, config, "car")
    assert 1 <= len(loops) <= 5
    for loop in loops:
        coords = traffic.loop_coords(loop)
        assert coords[0] == coords[-1]  # closed
        assert 100.0 <= loop.length <= 5000.0
        assert loop.kind == "car"
    assert len({loop.id for loop in loops}) == len(loops)  # no duplicates


def test_random_loops_are_deterministic():
    graph = traffic.build_graph(grid_ways())
    config = TrafficConfig(method="random", loop_count=5, seed=7, min_loop_length=100.0)
    first = [loop.id for loop in traffic.random_loops(graph, config, "car")]
    second = [loop.id for loop in traffic.random_loops(graph, config, "car")]
    assert first == second


def test_random_loops_reject_too_short():
    graph = traffic.build_graph(grid_ways())
    config = TrafficConfig(
        method="random", loop_count=5, seed=1, min_loop_length=1_000_000.0
    )
    assert traffic.random_loops(graph, config, "car") == []


def test_build_loops_dispatches_on_method():
    graph = traffic.build_graph(grid_ways())
    random_config = TrafficConfig(
        method="random", loop_count=3, seed=2, min_loop_length=100.0
    )
    assert len(traffic.build_loops(graph, random_config, "car")) == 3
    face_config = TrafficConfig(method="faces", min_loop_length=80.0)
    assert len(traffic.build_loops(graph, face_config, "car")) > 0


def test_parse_maxspeed():
    assert traffic.parse_maxspeed("50") == pytest.approx(50 / 3.6)
    assert traffic.parse_maxspeed("50 km/h") == pytest.approx(50 / 3.6)
    assert traffic.parse_maxspeed("30 mph") == pytest.approx(30 * 0.44704)
    assert traffic.parse_maxspeed("walk") == pytest.approx(1.4)
    assert traffic.parse_maxspeed("IT:urban") == pytest.approx(50 / 3.6)
    assert traffic.parse_maxspeed("signals") is None
    assert traffic.parse_maxspeed(None) is None


def slow_square():
    """A square whose first edge is tagged slow (2 m/s)."""
    ways = square_ways(9.18, 45.5, 0.001)
    ways[0] = Way(coords=ways[0].coords, highway="residential", maxspeed=2.0)
    return traffic.build_graph(ways)


def test_loop_period_uses_per_segment_speed():
    graph = slow_square()
    loop = traffic.find_loops(graph, TrafficConfig(min_loop_length=80.0))[0]
    assert min(loop.seg_speeds) == pytest.approx(2.0)
    assert max(loop.seg_speeds) == pytest.approx(10.0)  # residential default
    expected = sum(
        traffic.seg_length(seg) / speed
        for seg, speed in zip(loop.segs, loop.seg_speeds)
    )
    assert loop.period == pytest.approx(expected)
    assert loop.v == pytest.approx(loop.length / loop.period)


def test_split_runs_times_follow_segment_speeds():
    loop = traffic.find_loops(slow_square(), TrafficConfig(min_loop_length=80.0))[0]
    runs = traffic.split_runs(loop, 15)
    for _tile, t0, t1, _coords, times in runs:
        assert times[0] == pytest.approx(0.0)
        assert times == sorted(times)  # never goes back in time
        assert t1 - t0 == pytest.approx(times[-1])
    assert runs[-1][2] == pytest.approx(loop.period)


def test_fleet_records_round_trip_through_json():
    _, loops = find(square_ways(9.18, 45.5, 0.001))
    traffic.assign_vehicles(loops, TrafficConfig(spacing=50.0))
    records = traffic.fleets_to_records({"car": loops})
    # JSON-safe (no tuples), so it survives the cache's json.dumps/loads
    restored = traffic.fleets_from_records(json.loads(json.dumps(records)))
    loop, original = restored["car"][0], loops[0]
    assert loop.id == original.id
    assert loop.kind == original.kind
    assert loop.length == original.length
    assert loop.period == original.period
    assert loop.seg_speeds == original.seg_speeds
    assert loop.segs == original.segs
    assert loop.vehicles == original.vehicles
    # coordinates come back as tuples, so split_runs still matches on them
    assert all(isinstance(coord, tuple) for seg in loop.segs for coord in seg)


def test_fleet_cache_key_is_stable_and_input_sensitive():
    ways = {"car": square_ways(9.18, 45.5, 0.001)}
    configs = {"car": TrafficConfig(method="random", seed=1, loop_count=3)}
    key = traffic.fleets_cache_key(ways, configs)
    assert traffic.fleets_cache_key(ways, configs) == key  # stable
    # a retuned config is a different cache entry
    other = {"car": TrafficConfig(method="random", seed=2, loop_count=3)}
    assert traffic.fleets_cache_key(ways, other) != key
    # so is a different graph
    moved = {"car": square_ways(9.19, 45.5, 0.001)}
    assert traffic.fleets_cache_key(moved, configs) != key
