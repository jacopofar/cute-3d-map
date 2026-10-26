"""Construction sites, playgrounds, monuments, transit stops and fountains.

Part of ``tilegen/features``: the construction sites, playgrounds, monuments, transit stops and fountains.
"""

import math

from tiles import TileFeature

from .common import _flatten, area_square_meters, as_point, feature


def is_construction(tags) -> bool:
    """Whether the tags describe a construction site."""
    return tags.get("landuse") == "construction"


def to_construction(feature_id, tags, s, tile_box) -> TileFeature | None:
    """A construction site clipped to the tile like a park. The tile that holds
    the site centroid also carries the crane flag and the full site area, so a
    site spanning several tiles builds its cranes only once."""
    if s.geom_type not in ("Polygon", "MultiPolygon"):
        return None
    clipped = _flatten(s.intersection(tile_box), "Polygon")
    if clipped is None or area_square_meters(clipped) < 80:
        return None
    properties = {
        "cmtype": "construction",
        "construction": tags.get("construction"),
        "name": tags.get("name"),
    }
    centroid = s.centroid
    if centroid.within(tile_box):
        properties["crane"] = True
        properties["site_area"] = round(area_square_meters(s))
    return feature(feature_id, clipped, properties)


def is_playground(tags) -> bool:
    """Whether the tags describe a playground."""
    return tags.get("leisure") == "playground"


def to_playground(feature_id, tags, s) -> TileFeature | None:
    """A playground as a point with a radius-like size. The equipment is
    procedural; a mapped polygon gives a sensible spread, a node a default
    ten-meter playground."""
    if not is_playground(tags):
        return None
    size = 10.0
    point = as_point(s)
    if point is None or point.is_empty:
        return None
    if s.geom_type in ("Polygon", "MultiPolygon"):
        area = area_square_meters(s)
        size = max(6.0, min(18.0, 2.0 * math.sqrt(area / math.pi)))
    properties = {"cmtype": "playground", "size": round(size, 2)}
    if tags.get("name"):
        properties["name"] = tags["name"]
    return feature(feature_id, point, properties)


def monument_kind(tags) -> str | None:
    """The monument sub-kind for a historic/man_made feature."""
    if tags.get("man_made") == "obelisk":
        return "obelisk"
    if tags.get("historic") == "monument":
        return "monument"
    if tags.get("historic") == "memorial":
        return "memorial"
    return None


def is_monument(tags) -> bool:
    """Whether the tags describe a monument or memorial."""
    return monument_kind(tags) is not None


def to_monument(feature_id, tags, s) -> TileFeature | None:
    """A monument/memorial as a point; the frontend picks a pedestal/statue/
    obelisk/plaque from the kind and the `memorial` sub-tag."""
    kind = monument_kind(tags)
    if kind is None:
        return None
    point = as_point(s)
    if point is None or point.is_empty:
        return None
    properties = {"cmtype": "monument", "kind": kind}
    if tags.get("memorial"):
        properties["memorial"] = tags["memorial"]
    if tags.get("name"):
        properties["name"] = tags["name"]
    return feature(feature_id, point, properties)


def transit_kind(tags) -> str | None:
    """The stop kind a tag pair names, or None. Metro wins over a bus stop on
    the same node; trams are their own kind because the sign is the same but the
    popup should say so."""
    if tags.get("railway") == "subway_entrance":
        return "metro"
    if tags.get("railway") == "tram_stop":
        return "tram"
    if tags.get("highway") == "bus_stop":
        return "bus"
    return None


def to_transit_stop(feature_id, tags, s) -> TileFeature | None:
    """A metro entrance, tram stop or bus stop as a point. Shelters are a
    property (both the covered and the implied ones); the frontend draws the
    pole/sign for all stops and adds the shelter when it is set."""
    kind = transit_kind(tags)
    if kind is None:
        return None
    point = as_point(s)
    if point is None or point.is_empty:
        return None
    properties = {"cmtype": "transit_stop", "stop": kind}
    if tags.get("name"):
        properties["name"] = tags["name"]
    if kind != "metro" and (
        tags.get("shelter") == "yes" or tags.get("covered") == "yes"
    ):
        properties["shelter"] = True
    return feature(feature_id, point, properties)


def to_fountain(feature_id, tags, s) -> TileFeature | None:
    """A fountain as a point render feature. A mapped area collapses to its
    centroid and its equivalent diameter (clamped, so a whole square mapped as
    one fountain does not become a lake); a node keeps a small default size."""
    if tags.get("amenity") != "fountain":
        return None
    size = 2.4
    point = as_point(s)
    if point is None or point.is_empty:
        return None
    if s.geom_type in ("Polygon", "MultiPolygon"):
        area = area_square_meters(s)
        size = max(1.5, min(12.0, 2.0 * math.sqrt(area / math.pi)))
    properties = {
        "cmtype": "fountain",
        "size": round(size, 2),
        "name": tags.get("name"),
    }
    return feature(feature_id, point, properties)
