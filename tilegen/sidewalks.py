"""Author kerb-side sidewalk strips from the car-road network.

The road network is not emitted as render geometry, so sidewalks are authored
here as line features at the sidewalk centre. The frontend extrudes each line
into a low slab and kerb. Junctions are handled by clearing a small window
around every other car road and dropping the leftover slivers; a sidewalk never
runs across a carriageway.
"""

from dataclasses import dataclass

from parking import (
    DEFAULT_HALF_WIDTH,
    MIN_WAY_LENGTH,
    PARKING_HIGHWAYS,
    ROAD_HALF_WIDTH,
    ParkingWay,
    offset_polyline,
    way_length,
)

# shorter leftovers cannot hold a useful slab
MIN_SIDEWALK_LENGTH = 1.5


@dataclass(frozen=True)
class SidewalkLine:
    id: str
    coords: list[tuple[float, float]]
    width: float
    side: int


def sidewalk_centerlines(ways: list[ParkingWay]) -> list[SidewalkLine]:
    """One continuous centre line per sidewalk side, before junction clipping.

    The polygons are buffered and unioned per tile later; keeping the lines whole
    here means a bend or a corner keeps its full width instead of becoming two
    capping rectangles at a way split.
    """
    rows: list[SidewalkLine] = []
    for way in ways:
        if way.roundabout or way.highway not in PARKING_HIGHWAYS:
            continue
        if way_length(way.coords) < MIN_WAY_LENGTH:
            continue
        half_road = (
            way.width / 2
            if way.width
            else ROAD_HALF_WIDTH.get(way.highway, DEFAULT_HALF_WIDTH)
        )
        for side, enabled, width in (
            (1, way.sidewalk_left, way.sidewalk_width_left),
            (-1, way.sidewalk_right, way.sidewalk_width_right),
        ):
            if not enabled:
                continue
            coords = offset_polyline(way.coords, half_road + width / 2, side)
            if len(coords) < 2:
                continue
            rows.append(
                SidewalkLine(
                    id=f"{way.id}:{'L' if side > 0 else 'R'}",
                    coords=coords,
                    width=width,
                    side=side,
                )
            )
    return rows
