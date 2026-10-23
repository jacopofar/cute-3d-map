import parking
import sidewalks


def test_sidewalk_side_tags():
    assert parking.sidewalk_side({}, "left") is True
    assert parking.sidewalk_side({"sidewalk": "both"}, "right") is True
    assert parking.sidewalk_side({"sidewalk": "left"}, "left") is True
    assert parking.sidewalk_side({"sidewalk": "left"}, "right") is False
    assert parking.sidewalk_side({"sidewalk": "no"}, "left") is False
    assert parking.sidewalk_side({"sidewalk:right": "separate"}, "right") is False


def test_sidewalk_lines_use_both_sides_and_width():
    way = parking.ParkingWay(
        id="way/1",
        coords=[(9.0, 45.0), (9.0, 45.002)],
        highway="residential",
        sidewalk_width_left=2.4,
        sidewalk_width_right=1.8,
    )
    lines = sidewalks.sidewalk_centerlines([way])
    assert len(lines) == 2
    assert {line.side for line in lines} == {1, -1}
    assert {round(line.width, 1) for line in lines} == {1.8, 2.4}
    assert all(len(line.coords) >= 2 for line in lines)


def test_sidewalk_side_can_be_disabled():
    way = parking.ParkingWay(
        id="way/2",
        coords=[(9.0, 45.0), (9.0, 45.002)],
        highway="residential",
        sidewalk_left=False,
    )
    lines = sidewalks.sidewalk_centerlines([way])
    assert len(lines) == 1
    assert lines[0].side == -1
