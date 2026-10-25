"""Rail and tram ways, and their platforms.

Part of ``tilegen/features``: the rail and tram ways, and their platforms.
"""

import json

import shapely

from .common import _flatten, area_square_meters, parse_length

RAIL_KINDS = frozenset({"rail", "tram"})


def is_rail(tags) -> bool:
    """Whether the tags describe an above-ground rail/tram way."""
    return tags.get("railway") in RAIL_KINDS


def is_rail_platform(tags) -> bool:
    """Rail/tram platforms, not the bus platforms that share the OSM tags."""
    if tags.get("bus") == "yes" and not (
        tags.get("train") == "yes" or tags.get("tram") == "yes"
    ):
        return False
    if tags.get("railway") == "platform":
        return True
    return tags.get("public_transport") == "platform" and (
        tags.get("train") == "yes" or tags.get("tram") == "yes"
    )


def to_platform(feature_id, tags, s, tile_box) -> dict | None:
    """A rail platform as a clipped area. OSM often maps the platform as an
    edge line rather than a closed polygon, so buffer those to a 4 m ribbon."""
    if tags.get("bus") == "yes" and not (
        tags.get("train") == "yes" or tags.get("tram") == "yes"
    ):
        return None
    if s.geom_type in ("LineString", "MultiLineString"):
        s = s.buffer(2.0 / 111_000, cap_style="flat", join_style=2)
    clipped = _flatten(s.intersection(tile_box), "Polygon")
    if clipped is None or area_square_meters(clipped) < 15:
        return None
    properties = {
        "cmtype": "platform",
        "name": tags.get("name"),
        "ref": tags.get("ref"),
        "kind": tags.get("railway") or "platform",
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def to_rail(feature_id, tags, s, tile_box) -> dict | None:
    """A rail or tram way clipped to the tile. Underground, covered and
    bridge-deck tracks are skipped: the first are invisible and the last would
    otherwise be painted on the ground under the deck."""
    if s.geom_type not in ("LineString", "MultiLineString"):
        return None
    if tags.get("tunnel") in ("yes", "building_passage", "covered", "culvert"):
        return None
    if tags.get("bridge") not in (None, "no"):
        return None
    layer = parse_length(tags.get("layer"))
    if layer not in (None, 0):
        return None
    clipped = _flatten(s.intersection(tile_box), "LineString")
    if clipped is None:
        return None
    properties = {
        "cmtype": "rail",
        "kind": tags.get("railway"),
        "name": tags.get("name"),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }
