"""Walls, gates and fences.

Part of ``tilegen/features``: the walls, gates and fences.
"""

import json

import shapely

from .common import _flatten, parse_length

# barriers drawn as a line the frontend can build a fence band along. `fence` is
# the core; a guard rail or a railing is the same shape with a metal color, so
# they come along for free (the frontend colors by the `barrier` sub-kind).
FENCE_BARRIERS = frozenset({"fence", "guard_rail", "railing"})

WALL_BARRIERS = frozenset({"wall", "retaining_wall", "city_wall", "hoarding"})

GATE_BARRIERS = frozenset(
    {"gate", "lift_gate", "swing_gate", "wicket_gate", "sliding_gate"}
)

# a clip can leave a stub of fence a few centimeters long at a tile edge; it
# still costs a vertex band and a draw, and reads as nothing. The geometry here
# is in degrees (the tile box is lon/lat), so this is ~1 m at Milan's latitude.
MIN_FENCE_LENGTH = 1e-5


def fence_lines(geometry, tile_box, min_length: float = MIN_FENCE_LENGTH):
    """The barrier's line clipped to the tile, as a LineString / MultiLineString,
    or None when nothing long enough is left. Pure, so it is unit-tested."""
    clipped = _flatten(geometry.intersection(tile_box), "LineString")
    if clipped is None:
        return None
    parts = [part for part in shapely.get_parts(clipped) if part.length >= min_length]
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    return shapely.MultiLineString(parts)


def to_wall(feature_id, tags, s, tile_box) -> dict | None:
    """Build a low wall feature clipped to the tile."""
    barrier = tags.get("barrier")
    if barrier not in WALL_BARRIERS and not tags.get("wall"):
        return None
    geometry = s.boundary if s.geom_type in ("Polygon", "MultiPolygon") else s
    if geometry.geom_type not in ("LineString", "MultiLineString"):
        return None
    clipped = fence_lines(geometry, tile_box)
    if clipped is None:
        return None
    properties = {
        "cmtype": "wall",
        "wall": tags.get("wall") or barrier,
        "height": parse_length(tags.get("height")),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def to_gate(feature_id, tags, s, gate_bearings: dict[int, float] | None) -> dict | None:
    """Build a gate as two posts and a leaf."""
    if s.geom_type != "Point" or tags.get("barrier") not in GATE_BARRIERS:
        return None
    bearing = (gate_bearings or {}).get(feature_id)
    if bearing is None:
        return None
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {
            "cmtype": "gate",
            "bearing": round(bearing, 1),
            "width": 3.0,
        },
    }


def to_fence(feature_id, tags, s, tile_box) -> dict | None:
    """A barrier as a line the frontend turns into a fence band: a
    `barrier=fence` way (or guard rail / railing), or the outline of one drawn
    as a closed area.

    Like water, the line is clipped to the tile: a fence runs along a plot
    boundary across several tiles, and storing it whole in each would draw it
    over and over (and the frontend band wants only what is in the tile)."""
    barrier = tags.get("barrier")
    if barrier not in FENCE_BARRIERS:
        return None
    # a barrier closed into an area (a fenced enclosure) is a footprint: its
    # outline is the fence, and it clips and draws like any other line
    geometry = s.boundary if s.geom_type in ("Polygon", "MultiPolygon") else s
    if geometry.geom_type not in ("LineString", "MultiLineString"):
        return None
    clipped = fence_lines(geometry, tile_box)
    if clipped is None:
        return None
    properties = {
        "cmtype": "fence",
        "barrier": barrier,
        "name": tags.get("name"),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }
