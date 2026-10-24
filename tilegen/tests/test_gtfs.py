import zipfile

from city import CityProfile, VehicleOverride
from gtfs import load_gtfs_fleets, read_route_shapes

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


def _write_feed(path):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("routes.txt", ROUTES)
        archive.writestr("trips.txt", TRIPS)
        archive.writestr("shapes.txt", SHAPES)


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
