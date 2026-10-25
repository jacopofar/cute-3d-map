"""Water areas and waterways.

Part of ``tilegen/features``: the water areas and waterways.
"""

import json

import shapely

from .buildings import vertical_level
from .common import _flatten

# water areas: bodies of water mapped as polygons. `water` alone catches the
# water=* areas that carry no natural=water.
WATER_NATURAL = frozenset({"water", "bay", "strait", "wetland"})

WATER_LANDUSE = frozenset({"reservoir", "basin"})

# linear waterways: the frontend buffers these into ribbons, so only the classes
# that are actually a visible channel are kept (a weir or a waterfall is not)
WATERWAY_KINDS = frozenset({"river", "canal", "stream", "drain", "ditch"})


def water_kind(tags) -> str | None:
    """The water sub-kind ("lake", "river", ...) the frontend colors and sizes
    by, or None when the feature is not water at all."""
    natural = tags.get("natural")
    if natural in WATER_NATURAL:
        return tags.get("water") or ("wetland" if natural == "wetland" else "lake")
    if tags.get("landuse") in WATER_LANDUSE:
        return tags.get("water") or tags["landuse"]
    if tags.get("waterway") in ("riverbank", "dock"):
        return tags.get("water") or "lake"
    if "water" in tags:
        return tags.get("water") or "lake"
    return None


def is_water(tags) -> bool:
    """Whether the tags describe an OSM water area or waterway."""
    return water_kind(tags) is not None or tags.get("waterway") in WATERWAY_KINDS


def to_water(feature_id, tags, s, tile_box) -> dict | None:
    """A water body as a render feature: an area (polygon), or a waterway line
    the frontend buffers into a ribbon.

    The geometry is clipped to the tile, unlike buildings (small enough to store
    whole in every tile): a lake or a long canal spans many tiles, and storing
    its full outline in each would both bloat the tile and draw the same water
    surface over and over."""
    kind = water_kind(tags)
    if kind is None:
        kind = tags.get("waterway")
        if kind not in WATERWAY_KINDS:
            return None
    want = "Polygon" if s.geom_type in ("Polygon", "MultiPolygon") else "LineString"
    clipped = _flatten(s.intersection(tile_box), want)
    if clipped is None:
        return None
    properties = {
        "cmtype": "water",
        "water": kind,
        "name": tags.get("name"),
        # the OSM vertical position: `layer` when set (Seveso is layer=-2, a
        # culverted river below ground), else `level`. Negative is below ground;
        # the frontend draws those faint.
        "layer": vertical_level(tags),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }
