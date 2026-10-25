"""Parks, park paths and cemeteries.

Part of ``tilegen/features``: the parks, park paths and cemeteries.
"""

import json

import shapely

from tiles import TileFeature

from .common import _flatten, area_square_meters, parse_length

# green areas: parks, woods, lawns and pitches. The frontend draws them with a
# shader that has two styles, so each feature is classified into the style it
# wants. "grass" is a mown lawn / pitch / garden, "dense" a park, wood or scrub.
# Farmland is deliberately absent: there are thousands of farmland polygons and
# they would green the whole province.
GREEN_GRASS_LANDUSE = frozenset(
    {"grass", "village_green", "meadow", "recreation_ground"}
)

GREEN_GRASS_NATURAL = frozenset({"grassland", "grass"})

GREEN_GRASS_LEISURE = frozenset({"garden", "pitch"})

GREEN_DENSE_LEISURE = frozenset({"park", "common", "nature_reserve"})

GREEN_DENSE_NATURAL = frozenset({"wood", "scrub", "heath"})

GREEN_DENSE_LANDUSE = frozenset({"forest", "orchard"})

# a green area below this many square meters (after clipping to the tile) is
# dropped: a tile boundary clips a park into slivers, and thousands of specks
# cost geometry for no visible green.
MIN_GREEN_AREA = 40.0


def green_kind(tags) -> str | None:
    """The shader style ("grass" or "dense") a green area wants, or None when
    the feature is not green at all."""
    if tags.get("landuse") in GREEN_GRASS_LANDUSE:
        return "grass"
    if tags.get("natural") in GREEN_GRASS_NATURAL:
        return "grass"
    if tags.get("leisure") in GREEN_GRASS_LEISURE:
        return "grass"
    if tags.get("leisure") in GREEN_DENSE_LEISURE:
        return "dense"
    if tags.get("natural") in GREEN_DENSE_NATURAL:
        return "dense"
    if tags.get("landuse") in GREEN_DENSE_LANDUSE:
        return "dense"
    return None


def is_green(tags) -> bool:
    return green_kind(tags) is not None


# cemeteries: the ground is a clipped polygon like a park; the frontend fills it
# with procedural rows of tombstones. Kept as its own cmtype so the frontend can
# use a stone/grass palette instead of the park shader.
MIN_CEMETERY_AREA = 80.0

# paths: only the ways that actually pass through a park or green area. The
# sidewalk mapper already draws `footway=sidewalk` along roads, so those are not
# park paths, and a path underground or behind a private gate is not visible.
PARK_PATH_HIGHWAYS = frozenset({"footway", "path", "cycleway", "bridleway"})

PARK_PATH_EXCLUDED_FOOTWAY = frozenset({"sidewalk", "crossing"})


def is_park_path(tags) -> bool:
    """Whether a way is a foot/cycle path suitable for the park layer."""
    if tags.get("highway") not in PARK_PATH_HIGHWAYS:
        return False
    if tags.get("footway") in PARK_PATH_EXCLUDED_FOOTWAY:
        return False
    if tags.get("area") == "yes" or tags.get("indoor") == "yes":
        return False
    if tags.get("access") in ("private", "no"):
        return False
    return not (tags.get("location") == "underground" or tags.get("tunnel") == "yes")


def park_path_kind(tags) -> str:
    """`bike` wins a shared path: the bicycle is the faster, more distinctive
    surface to show, and `bicycle=designated` is explicit OSM intent."""
    if tags.get("highway") == "cycleway":
        return "bike"
    if tags.get("bicycle") in ("designated", "yes"):
        return "bike"
    return "walk"


def to_park_path(feature_id, tags, s, green_union, tile_box) -> TileFeature | None:
    """The part of a foot/cycle path that falls inside green space and the tile.

    Clipping to the union of the tile's green polygons means a long riverside
    path stops at the park boundary instead of running through the city, and a
    path crossing a tile boundary is stored only once per tile.
    """
    if not is_park_path(tags) or s.geom_type not in ("LineString", "MultiLineString"):
        return None
    captured = s.intersection(green_union)
    if captured.is_empty:
        return None
    captured = captured.intersection(tile_box)
    line = _flatten(captured, "LineString")
    if line is None:
        return None
    width = parse_length(tags.get("width"))
    properties = {
        "cmtype": "park_path",
        "kind": park_path_kind(tags),
        "surface": tags.get("surface"),
        "width": width,
        "name": tags.get("name"),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(line)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def is_cemetery(tags) -> bool:
    """Whether the tags describe a cemetery area."""
    return tags.get("landuse") == "cemetery" or tags.get("amenity") == "grave_yard"


def to_cemetery(feature_id, tags, s, tile_box) -> TileFeature | None:
    """A cemetery area, clipped to the tile like a park. The individual graves
    are not mapped in enough places to render, so the frontend lays out rows of
    simple tombstones inside this polygon."""
    if s.geom_type not in ("Polygon", "MultiPolygon"):
        return None
    clipped = _flatten(s.intersection(tile_box), "Polygon")
    if clipped is None or area_square_meters(clipped) < MIN_CEMETERY_AREA:
        return None
    properties = {
        "cmtype": "cemetery",
        "name": tags.get("name"),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def pitch_sport(tags) -> str | None:
    """The `sport` of a pitch, passed through for the frontend to paint.

    A pitch is already a green area (``leisure=pitch`` is in
    ``GREEN_GRASS_LEISURE``), so nothing here draws it: the frontend decides
    which sports it has a layout for. ``sport`` can be a ";" list, so the raw
    value travels and the frontend picks the first entry it knows."""
    if tags.get("leisure") != "pitch":
        return None
    value = tags.get("sport")
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().lower()


def to_green(feature_id, tags, s, tile_box) -> TileFeature | None:
    """A green area as a render feature, clipped to the tile like water (a park
    spans many tiles). The `green` sub-kind selects the frontend shader style."""
    kind = green_kind(tags)
    if kind is None or s.geom_type not in ("Polygon", "MultiPolygon"):
        return None
    clipped = _flatten(s.intersection(tile_box), "Polygon")
    if clipped is None or area_square_meters(clipped) < MIN_GREEN_AREA:
        return None
    properties = {
        "cmtype": "green",
        "green": kind,
        "sport": pitch_sport(tags),
        "name": tags.get("name"),
    }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(clipped)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }
