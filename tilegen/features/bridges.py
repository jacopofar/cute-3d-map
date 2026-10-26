"""Bridges and tunnel portals.

Part of ``tilegen/features``: the bridges and tunnel portals.
"""

import json
import math

import shapely
from shapely.geometry import Point

from tiles import TileFeature

from .buildings import vertical_level
from .common import _flatten, transport_class


# a bridge is a way carrying `bridge` (any value other than "no"): the common
# `bridge=yes`, plus the viaducts/aqueducts/covered/boardwalk. `man_made=bridge`
# is the deck drawn as its own polygon, and `building=bridge` is a bridge
# mis-mapped as a building (the diary flags it: it used to get a full roof and
# facade); both become a deck here instead.
def is_bridge(tags) -> bool:
    """Whether the tags describe a bridge way or footprint."""
    if tags.get("man_made") == "bridge" or tags.get("building") == "bridge":
        return True
    # a carried way: the deck only makes sense for a road or rail class
    return tags.get("bridge") not in (None, "no") and transport_class(tags) is not None


# a tunnel is a way carrying `tunnel` (any value other than "no"). A
# building_passage is an arcade under a house and a culvert is a drain: neither
# is a road tunnel the user would recognize, so they stay out.
TUNNEL_SKIP = frozenset({"no", "culvert", "building_passage"})


def is_tunnel(tags) -> bool:
    """Whether the tags describe a tunnel way."""
    return tags.get("tunnel") is not None and tags.get("tunnel") not in TUNNEL_SKIP


# the only tunnels worth a portal: roads and railways. Most `tunnel=yes` ways in
# the extract are footway/steps underpasses (thousands of them), which are not
# the road tunnel the user pictures and would bury the scene in tiny frames.
def runs_underground(tags) -> bool:
    """Whether a way runs under something, for hiding vehicles on it.

    Broader than `is_tunnel` on purpose: a building passage draws no portal
    (thousands of footway underpasses would bury the scene in frames) but a
    vehicle inside one has to be off the map, and a way mapped below ground is
    under it whatever its tunnel tag says."""
    tunnel = tags.get("tunnel")
    # `building_passage` is in TUNNEL_SKIP for portals, but it is exactly a way
    # under a building, so only "no" and a culvert are excluded here
    if tunnel is not None and tunnel not in ("no", "culvert"):
        return True
    if tags.get("covered") == "yes":
        return True
    layer = tags.get("layer")
    try:
        return layer is not None and float(layer) < 0
    except (TypeError, ValueError):
        return False


PORTAL_CLASSES = frozenset(
    {
        "motorway",
        "motorway_link",
        "trunk",
        "trunk_link",
        "primary",
        "primary_link",
        "secondary",
        "secondary_link",
        "tertiary",
        "tertiary_link",
        "residential",
        "unclassified",
        "living_street",
        "service",
        "rail",
        "light_rail",
        "narrow_gauge",
        "tram",
    }
)


def to_bridge(feature_id, tags, s, tile_box) -> TileFeature | None:
    """A bridge as a render feature: a way's line (the deck the frontend raises
    into a slab), or a `man_made=bridge` / `building=bridge` polygon (the deck
    footprint, drawn as a slab).

    Like water, the geometry is clipped to the tile: a bridge crosses several
    tiles and storing it whole in each would draw it over and over. Tunnels are
    handled separately (they only show as portals)."""
    if s.geom_type in ("Polygon", "MultiPolygon"):
        clipped = _flatten(s.intersection(tile_box), "Polygon")
    else:
        clipped = _flatten(s.intersection(tile_box), "LineString")
    if clipped is None:
        return None
    properties = {
        "cmtype": "bridge",
        # the OSM `layer` when set (a deck above a road is 1); the frontend uses
        # it as the deck height proxy
        "layer": vertical_level(tags),
        "class": transport_class(tags),
        # the deck footprint is a bridge in its own right; give it a value so
        # the frontend can tell it apart from a carried way if it ever wants to
        "bridge": tags.get("bridge") or "deck",
        "name": tags.get("name"),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def portal_angle(lon0: float, lat0: float, lon1: float, lat1: float) -> float:
    """The tunnel's direction at a portal, as the atan2 in model space. Lon/lat
    are not isotropic (a degree of longitude is `cos(lat)` of a degree of
    latitude in meters), so the scale is folded in here rather than making the
    frontend redo it."""
    dx = (lon1 - lon0) * math.cos(math.radians(lat0))
    dy = lat1 - lat0
    return math.atan2(dy, dx)


def tunnel_portals(s, tile_box) -> list[tuple[Point, float]]:
    """The true ends of a tunnel way that lie inside the tile, with the tunnel's
    direction there: where the tunnel meets the surface, i.e. a portal. Emitting
    the clipped line instead would put a portal on every tile boundary, which is
    not a portal at all."""
    ends: list[tuple[Point, float]] = []
    for part in shapely.get_parts(s):
        if part.geom_type != "LineString":
            continue
        coords = list(part.coords)
        if len(coords) < 2:
            continue
        for point, neighbour in ((coords[0], coords[1]), (coords[-1], coords[-2])):
            if tile_box.contains(Point(point)):
                ends.append(
                    (
                        Point(point),
                        portal_angle(point[0], point[1], neighbour[0], neighbour[1]),
                    )
                )
    return ends


def to_tunnel(feature_id, tags, s, tile_box) -> list[TileFeature]:
    """A tunnel's portal(s): a Point per end of the way that falls in the tile,
    carrying the tunnel's direction. The underground part is deliberately not
    drawn — a tunnel is invisible, and the honest, visible thing is the opening
    where it meets the surface. A way whose ends are all outside the tile (the
    tunnel merely passes under it) contributes nothing."""
    transport = transport_class(tags)
    if transport not in PORTAL_CLASSES:
        return []
    portal = {
        "cmtype": "tunnel",
        "layer": vertical_level(tags),
        "class": transport,
        "name": tags.get("name"),
    }
    properties = {k: v for k, v in portal.items() if v is not None}
    return [
        {
            "type": "feature",
            "id": feature_id,
            "geometry": json.loads(shapely.to_geojson(point)),
            "properties": {**properties, "angle": round(angle, 4)},
        }
        for point, angle in tunnel_portals(s, tile_box)
    ]
