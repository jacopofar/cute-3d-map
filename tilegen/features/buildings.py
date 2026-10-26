"""Buildings, building parts and glass facades.

Part of ``tilegen/features``: the buildings, building parts and glass facades.
"""

import json
import logging

import shapely

from city import BuildingOverride
from impute import impute
from tiles import TileFeature

from .common import parse_length, parse_level, parse_number

logger = logging.getLogger(__name__)


GLASS_MATERIAL_TAGS = ("building:material", "building:facade:material")


def is_glass(tags) -> bool:
    """Whether the facade is tagged as glass/mirror. The values are free text and
    may be `;` lists (`plaster;glass`), so look for the words rather than compare
    the whole string."""
    for tag in GLASS_MATERIAL_TAGS:
        value = str(tags.get(tag, "")).lower()
        if "glass" in value or "mirror" in value:
            return True
    return False


def vertical_level(tags) -> float | None:
    """A feature's OSM vertical position: `layer` when it is set (the tunnel /
    bridge ordering: Seveso is `layer=-2`, a bridge is `layer=1`), else `level`.
    Negative means below ground."""
    return parse_level(tags.get("layer") or tags.get("level"))


def building_base(tags) -> float:
    """The bottom of a building volume: `min_height`, else `min_level` * 3 m.
    Building parts often start above the street (a tower on a podium)."""
    base = parse_length(tags.get("min_height"))
    if base is None:
        level = parse_level(tags.get("min_level") or tags.get("building:min_level"))
        if level is not None:
            base = level * 3
    return max(0.0, base or 0.0)


def building_top(tags, base: float) -> float | None:
    """The top of a building volume. `height` is the top elevation when present;
    otherwise `max_level` is the top, or the level count is added to the base."""
    height = parse_length(tags.get("height"))
    if height is None:
        max_level = parse_level(tags.get("max_level"))
        if max_level is not None:
            height = max_level * 3
        elif "building:levels" in tags:
            levels = parse_number(tags["building:levels"])
            if levels is not None:
                height = base + levels * 3
    if height is not None and height <= base:
        return base + 0.5
    if height is None and base > 0:
        # a part with a base but no height should still have a sensible volume
        return base + 10.0
    return height


def to_building(
    feature_id,
    tags,
    s,
    distributions=None,
    solar_buildings=None,
    override: BuildingOverride | None = None,
) -> TileFeature | None:
    """Build a building or building-part feature with imputed tags."""
    if s.geom_type == "Point":
        logger.warning(f"Point building?? {feature_id}")
        return None
    if s.geom_type not in ("Polygon", "MultiPolygon"):
        # don't abort the whole tile run over one weird feature
        logger.warning(f"non-polygon building?? {feature_id} ({s.geom_type})")
        return None
    base = building_base(tags)
    height = building_top(tags, base)

    values, sampled = impute(tags, feature_id, distributions or {})
    if override is not None:
        if override.color:
            values["color"] = override.color
            sampled = [field for field in sampled if field != "color"]
        if override.roof_color:
            values["roof_color"] = override.roof_color
            sampled = [field for field in sampled if field != "roof_color"]
        if override.roof_shape:
            values["roof_shape"] = override.roof_shape
            sampled = [field for field in sampled if field != "roof_shape"]
    properties = {
        "cmtype": "building",
        "height": height,
        "base": base or None,
        "name": tags.get("name"),
        "street": tags.get("addr:street"),
        "housenumber": tags.get("addr:housenumber"),
        # a curtain wall: the frontend drops the windows/balconies/door and gives
        # the walls their own glass material. Never imputed: a glass look is a
        # statement about the real facade, not something to invent.
        "glass": is_glass(tags) or None,
        # a church is an ordinary building=* polygon, so the value that says so
        # (church, chapel, cathedral, ...) has to be reported; religion only
        # matters for a place of worship that is not tagged by building value
        "building": tags.get("building"),
        "religion": (
            tags.get("religion") if tags.get("amenity") == "place_of_worship" else None
        ),
        # color, roof_shape and roof_color: the OSM tag when present, otherwise
        # a sample from the dataset's own distribution (see tilegen/impute.py).
        # `imputed` names the fields that were sampled rather than tagged.
        **values,
        "facade": override.facade if override else None,
        "imputed": sampled or None,
        # a building carrying mapped solar panels keeps a flat top so the
        # panels sit on it instead of disappearing inside a pitched roof
        "solar": (
            True if solar_buildings and str(feature_id) in solar_buildings else None
        ),
    }
    if override is not None and override.model is not None:
        properties["model"] = {
            "file": override.model.file,
            "scale": override.model.scale,
            "rotation": override.model.rotation,
            "offset": list(override.model.offset),
        }
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }
