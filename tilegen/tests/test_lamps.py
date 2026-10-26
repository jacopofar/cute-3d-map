import math

import lamps
import parking
from geo import coord_to_tile

LON, LAT = 9.0, 45.0


def _way(highway="residential", length_m=220.0, roundabout=False, underground=False):
    # a due-north way of roughly `length_m` metres
    lat_end = LAT + length_m / parking.METERS_PER_DEG_LAT
    return parking.ParkingWay(
        id="way/1",
        coords=[(LON, LAT), (LON, lat_end)],
        highway=highway,
        roundabout=roundabout,
        underground=underground,
    )


def _flatten(by_tile):
    return [spot for tile in by_tile.values() for spot in tile]


def test_lamps_sit_on_both_sides_at_the_requested_pitch():
    way = _way(length_m=220)
    spots = _flatten(lamps.lamp_spots([way]))
    # two rows, roughly every 55 m
    assert len(spots) == 2 * 3
    east = [spot[0] for spot in spots]
    assert min(east) < LON < max(east)
    # both sides are about the same distance from the centreline
    left = [spot for spot in spots if spot[0] < LON]
    right = [spot for spot in spots if spot[0] > LON]
    assert len(left) == len(right) == 3


def test_lamps_skip_roundabouts_and_short_ways():
    assert lamps.lamp_spots([_way(roundabout=True)]) == {}
    assert lamps.lamp_spots([_way(length_m=10)]) == {}


def test_lamps_are_grouped_by_tile_and_stable():
    way = _way(length_m=220)
    by_tile = lamps.lamp_spots([way])
    assert by_tile
    for tile, spots in by_tile.items():
        for lon, lat in spots:
            assert coord_to_tile(lon, lat, 15) == tile
    assert lamps.lamp_spots([way]) == by_tile


def test_lamp_offset_is_outside_the_carriageway():
    way = _way(length_m=220)
    spots = _flatten(lamps.lamp_spots([way]))
    east = [
        abs((spot[0] - LON) * 111320 * math.cos(math.radians(LAT))) for spot in spots
    ]
    half = parking.ROAD_HALF_WIDTH["residential"]
    assert all(distance > half for distance in east)
    assert all(distance < half + 2 for distance in east)


def test_a_tunnel_gets_no_lamps():
    # a lamp under the ground would hang over whatever is above the tunnel
    assert _flatten(lamps.lamp_spots([_way(underground=True)])) == []
    assert len(_flatten(lamps.lamp_spots([_way()]))) > 0
