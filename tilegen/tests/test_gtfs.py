import zipfile

import pytest

from city import CityProfile, VehicleOverride
from gtfs import (
    GTFS_SPEED_FACTOR,
    MIN_STOP_DWELL,
    load_gtfs_fleets,
    read_route_shapes,
)

ROUTES = """route_id,route_short_name,route_long_name,route_type,route_color
R1,1,One,3,ff0000
R2,2,Two,0,
R3,M,Metro,1,
"""

TRIPS = """route_id,trip_id,shape_id,trip_headsign,trip_short_name
R1,t1,SBUS,Terminus A,
R2,t2,STRAM,Terminus B,
R3,t3,SMETRO,Metro,
"""

# stops sit on the SBUS shape so their projected distance grows along it
STOPS = """stop_id,stop_lon,stop_lat
A,9.0000,45.0000
B,9.0010,45.0010
C,9.0020,45.0020
"""

STOP_TIMES = """trip_id,arrival_time,departure_time,stop_id,stop_sequence
t1,08:00:00,08:00:30,A,1
t1,08:02:00,08:02:20,B,2
t1,08:04:00,08:04:00,C,3
"""

SHAPES = """shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence
SBUS,45.0000,9.0000,1
SBUS,45.0010,9.0010,2
SBUS,45.0020,9.0020,3
STRAM,45.0100,9.0100,1
STRAM,45.0110,9.0110,2
STRAM,45.0120,9.0120,3
SMETRO,45.0200,9.0200,1
SMETRO,45.0210,9.0210,2
"""


def _write_feed(path, stops=None, stop_times=None):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("routes.txt", ROUTES)
        archive.writestr("trips.txt", TRIPS)
        archive.writestr("shapes.txt", SHAPES)
        if stops is not None:
            archive.writestr("stops.txt", stops)
        if stop_times is not None:
            archive.writestr("stop_times.txt", stop_times)


def test_gtfs_shapes_become_bus_and_tram_loops(tmp_path):
    path = tmp_path / "feed.zip"
    _write_feed(path)
    fleets = load_gtfs_fleets(path)
    assert set(fleets) == {"bus", "tram"}
    assert len(fleets["bus"]) == 1
    assert len(fleets["tram"]) == 1
    bus = fleets["bus"][0]
    assert bus.kind == "bus"
    assert bus.meta is not None
    assert bus.meta["line"] == "1"
    assert bus.meta["headsign"] == "Terminus A"
    assert bus.segs[0][0] != bus.segs[0][-1]
    assert bus.period > 0
    assert bus.vehicles
    assert fleets["tram"][0].meta is not None
    assert fleets["tram"][0].meta["line"] == "2"
    shapes = read_route_shapes(path)
    assert len(shapes) == 2
    bus_shape = next(shape for shape in shapes if shape["kind"] == "bus")
    assert bus_shape["line"] == "1"
    assert bus_shape["directions"] == {"": 1}
    assert bus_shape["closed"] is False
    colored = load_gtfs_fleets(path, city=CityProfile(vehicle_by_line={"1": "f2c94c"}))
    assert colored["bus"][0].vehicles[0]["color"] == "f2c94c"
    styled = load_gtfs_fleets(
        path,
        city=CityProfile(
            vehicle_default_color="1b5e20",
            vehicle_by_line={
                "1": VehicleOverride(color="ec7c26", length=15.2),
            },
        ),
    )
    assert styled["bus"][0].vehicles[0]["color"] == "ec7c26"
    assert styled["bus"][0].vehicle_length == 15.2
    assert styled["tram"][0].vehicles[0]["color"] == "1b5e20"
    assert styled["tram"][0].vehicle_length is None


def test_stop_times_set_segment_travel_and_dwell(tmp_path):
    path = tmp_path / "feed.zip"
    _write_feed(path, stops=STOPS, stop_times=STOP_TIMES)
    bus = load_gtfs_fleets(path)["bus"][0]

    # A->B and B->C, not the three shape points
    assert len(bus.segs) == 2
    assert bus.seg_times is not None and bus.seg_dwells is not None
    # travel: (arrival at the next stop - departure here) / GTFS_SPEED_FACTOR
    assert bus.seg_times[0] == (120 - 30) / GTFS_SPEED_FACTOR
    assert bus.seg_times[1] == (240 - 140) / GTFS_SPEED_FACTOR
    # dwell: the scheduled pause, but never less than MIN_STOP_DWELL
    assert bus.seg_dwells[0] == 20  # 08:02:20 - 08:02:00
    assert bus.seg_dwells[1] == MIN_STOP_DWELL  # arrival == departure at C
    assert bus.period == sum(bus.seg_times) + sum(bus.seg_dwells)
    assert bus.length > 0
    # each segment's speed is its own length over its scheduled time, so the
    # distance walked at those speeds adds up to the loop's length
    assert all(speed > 0 for speed in bus.seg_speeds)
    walked = sum(speed * travel for speed, travel in zip(bus.seg_speeds, bus.seg_times))
    assert walked == pytest.approx(bus.length)
    assert bus.meta is not None and bus.meta["line"] == "1"


def test_a_feed_without_stops_falls_back_to_the_shape(tmp_path):
    path = tmp_path / "feed.zip"
    _write_feed(path)
    bus = load_gtfs_fleets(path)["bus"][0]
    # no stop times: one segment, timed by the default speed
    assert len(bus.segs) == 1
    assert bus.seg_times is None
    assert bus.period > 0


def test_unusable_stop_times_fall_back_to_the_shape(tmp_path):
    path = tmp_path / "feed.zip"
    # the stops are unknown, so no stop resolves onto the shape
    _write_feed(
        path,
        stops="stop_id,stop_lon,stop_lat\nZ,9.5,45.5\n",
        stop_times=STOP_TIMES,
    )
    bus = load_gtfs_fleets(path)["bus"][0]
    assert len(bus.segs) == 1
    assert bus.seg_times is None


def test_stop_times_without_times_are_skipped(tmp_path):
    path = tmp_path / "feed.zip"
    _write_feed(
        path,
        stops=STOPS,
        stop_times=(
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
            "t1,,,A,1\n"
            "t1,,,B,2\n"
        ),
    )
    bus = load_gtfs_fleets(path)["bus"][0]
    assert len(bus.segs) == 1
    assert bus.seg_times is None


def test_malformed_rows_are_skipped(tmp_path):
    path = tmp_path / "feed.zip"
    _write_feed(
        path,
        # a stop with no coordinates and one with a non-numeric pair
        stops="stop_id,stop_lon,stop_lat\nA,9.0000,45.0000\nB,,\nC,x,y\n",
        stop_times=(
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
            "t1,08:00:00,08:00:30,A,1\n"
            "t1,08:02:00,08:02:20,B,not-a-number\n"
            "t1,08:04:00,08:04:00,C,3\n"
            "other,09:00:00,09:00:00,A,1\n"
        ),
    )
    # the bad stop_sequence drops that row, so B never resolves and the
    # remaining two stops are not enough for a scheduled loop
    bus = load_gtfs_fleets(path)["bus"][0]
    assert len(bus.segs) == 1
    assert bus.seg_times is None
