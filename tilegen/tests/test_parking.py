import math

import pytest
import shapely

import parking


def test_way_length_is_measured_in_meters():
    # 0.001 degrees of latitude is about 110.54 m
    assert parking.way_length([(9.0, 45.0), (9.0, 45.001)]) == pytest.approx(
        110.54, rel=1e-3
    )


def test_walk_way_places_bays_at_the_pitch_inset_from_both_ends():
    spots = parking.walk_way([(9.0, 45.0), (9.0, 45.001)], 4.0)
    assert len(spots) == 27
    latitudes = [spot[1] for spot in spots]
    assert latitudes == sorted(latitudes)
    assert spots[0][1] > 45.0
    assert spots[-1][1] < 45.001
    # a due-north way points north
    assert all(heading == pytest.approx(math.pi / 2) for _, _, heading in spots)


def test_parking_style_is_seeded_and_class_dependent():
    # narrow streets are mostly parallel; wide roads turn to bays
    assert parking.parking_style(50, "residential") == parking.PARALLEL
    assert parking.parking_style(50, "secondary") == parking.PERPENDICULAR
    assert parking.parking_style(1234, "tertiary") == parking.parking_style(
        1234, "tertiary"
    )
    styles = {parking.parking_style(seed, "residential") for seed in range(1000)}
    assert styles == {parking.PARALLEL, parking.PERPENDICULAR, parking.FISHBONE}


def test_bay_pitch_orders_the_styles_by_their_along_road_footprint():
    assert (
        parking.bay_pitch(parking.PARALLEL)
        > parking.bay_pitch(parking.FISHBONE)
        > parking.bay_pitch(parking.PERPENDICULAR)
    )


def test_a_parallel_car_sits_beyond_the_kerb_and_faces_the_traffic_side():
    # an eastbound road: the left side is north, the right side south
    _, left_lat, left_heading = parking._car_at(
        9.0, 45.0, 0.0, 1, parking.PARALLEL, "residential"
    )
    _, right_lat, right_heading = parking._car_at(
        9.0, 45.0, 0.0, -1, parking.PARALLEL, "residential"
    )
    assert left_lat > 45.0
    assert right_lat < 45.0
    assert left_heading == pytest.approx(math.pi)
    assert right_heading == pytest.approx(0.0)
    # a perpendicular bay points across the road
    _, _, heading = parking._car_at(
        9.0, 45.0, 0.0, 1, parking.PERPENDICULAR, "residential"
    )
    assert heading == pytest.approx(math.pi / 2)


def test_parking_spots_skips_roundabouts_and_short_ways():
    short = parking.ParkingWay(
        id="way/1",
        coords=[(9.0, 45.0), (9.0, 45.0001)],
        highway="residential",
    )
    roundabout = parking.ParkingWay(
        id="way/2",
        coords=[(9.0, 45.0), (9.0, 45.001)],
        highway="residential",
        roundabout=True,
    )
    assert parking.parking_spots([short, roundabout]) == {}


def test_parking_spots_fills_both_sides_and_keeps_95_percent():
    coords = [(9.0, 45.0), (9.0, 45.002)]
    way = parking.ParkingWay(id="way/1", coords=coords, highway="residential")
    by_tile = parking.parking_spots([way])
    spots = [spot for tile in by_tile.values() for spot in tile]

    style = parking.parking_style(parking._hash(way.id), way.highway)
    bays_per_side = len(parking.walk_way(coords, parking.bay_pitch(style)))
    assert len(spots) <= 2 * bays_per_side
    # 95% occupancy: a few empty bays, but the sides are packed
    assert len(spots) >= 0.88 * 2 * bays_per_side
    # both sides of the north-south way (west and east of it)
    assert min(spot[0] for spot in spots) < 9.0 < max(spot[0] for spot in spots)
    # and every spot is in a tile
    assert by_tile
    assert all(len(spot) == 3 for spot in spots)


def test_offset_polyline_moves_to_the_requested_side():
    coords = [(9.0, 45.0), (9.0, 45.001)]
    left = parking.offset_polyline(coords, 4.0, 1)
    right = parking.offset_polyline(coords, 4.0, -1)
    assert left[0][0] < 9.0 < right[0][0]
    # the north-running way is offset east/west by four meters
    assert abs(
        (left[0][0] - 9.0) * parking.METERS_PER_DEG_LON * math.cos(math.radians(45.0))
    ) == pytest.approx(4.0, rel=0.02)


def test_parking_rows_stop_short_of_a_junction():
    main_way = parking.ParkingWay(
        id="way/1", coords=[(9.0, 45.0), (9.0, 45.001)], highway="residential"
    )
    cross = parking.ParkingWay(
        id="way/2", coords=[(9.0, 45.001), (9.001, 45.001)], highway="residential"
    )
    alone = [
        row for row in parking.parking_rows([main_way]) if row.id.startswith("way/1")
    ]
    at_junction = [
        row
        for row in parking.parking_rows([main_way, cross])
        if row.id.startswith("way/1")
    ]
    assert alone and at_junction
    assert max(parking.way_length(row.coords) for row in at_junction) < max(
        parking.way_length(row.coords) for row in alone
    )
    # the trimmed end is no longer on the crossing road
    for row in at_junction:
        for endpoint in (row.coords[0], row.coords[-1]):
            assert (
                min(
                    parking._way_at(cross, endpoint)[0],
                    parking._way_at(main_way, endpoint)[0],
                )
                < 50.0
            )


def test_parking_row_is_split_at_a_mid_path_crossing():
    coords = [(9.0, 45.0), (9.0, 45.002)]
    way = parking.ParkingWay(id="way/1", coords=coords, highway="residential")
    cross = parking.ParkingWay(
        id="way/2",
        coords=[(8.999, 45.001), (9.001, 45.001)],
        highway="residential",
    )
    ways = [way, cross]
    tree = shapely.STRtree([shapely.LineString(w.coords) for w in ways])
    pieces = parking.clear_pieces(
        shapely.LineString(coords), coords, way.id, ways, tree, 4.0
    )
    assert len(pieces) == 2
    assert all(parking.way_length(piece) >= 4.0 for piece in pieces)
    assert all(
        min(parking._way_at(cross, piece[0])[0], parking._way_at(cross, piece[-1])[0])
        > 7.0
        for piece in pieces
    )


def test_parking_rows_carry_style_pitch_and_both_sides():
    way = parking.ParkingWay(
        id="way/7", coords=[(9.0, 45.0), (9.0, 45.002)], highway="tertiary"
    )
    rows = parking.parking_rows([way])
    assert len(rows) == 2
    assert {row.side for row in rows} == {1, -1}
    assert all(row.id.startswith("way/7:") for row in rows)
    assert all(row.pitch == parking.bay_pitch(row.style) for row in rows)
    assert all(row.occupancy == parking.OCCUPANCY for row in rows)
    assert all(len(row.coords) >= 2 for row in rows)


def test_parking_spots_is_stable_across_rebuilds():
    way = parking.ParkingWay(
        id="way/9",
        coords=[(9.0, 45.0), (9.0, 45.002)],
        highway="tertiary",
    )
    assert parking.parking_spots([way]) == parking.parking_spots([way])


def _flatten(by_tile):
    return [spot for tile in by_tile.values() for spot in tile]


def _min_distance(spots):
    best = math.inf
    for i in range(len(spots)):
        for j in range(i + 1, len(spots)):
            dx = (
                (spots[i][0] - spots[j][0])
                * parking.METERS_PER_DEG_LON
                * math.cos(math.radians(spots[i][1]))
            )
            dy = (spots[i][1] - spots[j][1]) * parking.METERS_PER_DEG_LAT
            best = min(best, math.hypot(dx, dy))
    return best


def test_overlapping_ways_are_deduped_and_the_bigger_road_wins():
    coords = [(9.0, 45.0), (9.0, 45.002)]
    # the service way runs ~0.4 m beside the secondary: their bays collide
    beside = [(9.000005, 45.0), (9.000005, 45.002)]
    secondary = parking.ParkingWay(id="way/2", coords=coords, highway="secondary")
    service = parking.ParkingWay(id="way/1", coords=beside, highway="service")
    only_secondary = _flatten(parking.parking_spots([secondary]))
    both = _flatten(parking.parking_spots([secondary, service]))
    # the secondary is processed first, so every one of its bays survives ...
    assert set(map(tuple, only_secondary)) <= set(map(tuple, both))
    # ... some of the service way's colliding bays are dropped, but not all
    only_service = _flatten(parking.parking_spots([service]))
    assert len(both) < len(only_secondary) + len(only_service)
    assert len(both) > len(only_secondary)
    # nothing that survives sits on top of another car
    assert _min_distance(both) >= parking.MIN_SPOT_SPACING - 1e-6


def test_dedupe_threshold_is_below_the_closest_bay_pitch():
    # adjacent perpendicular bays must survive; only cross-way overlaps go
    assert parking.MIN_SPOT_SPACING < parking.bay_pitch(parking.PERPENDICULAR)


def test_dedupe_drops_two_cars_closer_than_the_spacing():
    a = (9.0, 45.0, 0.0)
    # 1.5 m north of the first
    b = (9.0, 45.0 + 1.5 / parking.METERS_PER_DEG_LAT, 0.0)
    assert len(parking._dedupe([a, b])) == 1
