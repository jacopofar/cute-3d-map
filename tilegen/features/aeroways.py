"""Runways, taxiways, aprons and helipads.

Part of ``tilegen/features``: the runways, taxiways, aprons and helipads.
"""

import json
import logging

import shapely

from .common import parse_length

logger = logging.getLogger(__name__)


# airport surfaces the frontend draws as flat tarmac. The lines (runways,
# taxiways) are buffered to a ribbon by their width; the areas (aprons,
# helipad polygons) are drawn as polygons.
AEROWAY_LINE_KINDS = frozenset({"runway", "taxiway"})

AEROWAY_AREA_KINDS = frozenset({"apron", "helipad"})

# fallback widths in meters when OSM has no `width` tag: a runway is wide
# enough for an airliner, a taxiway a third of that
DEFAULT_AEROWAY_WIDTH = {"runway": 45.0, "taxiway": 15.0}


def to_aeroway(feature_id, tags, s) -> dict | None:
    """An airport surface as a render feature: a runway/taxiway line (the
    frontend buffers it with the width below) or an apron/helipad area.

    Unlike water, the geometry is stored whole in every tile it touches, not
    clipped: a runway is a single narrow line, and a piece of it would read as
    an orphan stripe at the tile edge (also the surface has to line up with the
    plane path, which the frontend derives from the same line). The frontend
    dedupes runways by id before using them."""
    kind = tags.get("aeroway")
    if kind in AEROWAY_LINE_KINDS:
        if s.geom_type not in ("LineString", "MultiLineString"):
            logger.warning(f"non-line {kind}?? {feature_id} ({s.geom_type})")
            return None
        width = parse_length(tags.get("width")) or DEFAULT_AEROWAY_WIDTH[kind]
    elif kind in AEROWAY_AREA_KINDS:
        if s.geom_type not in ("Polygon", "MultiPolygon"):
            # a helipad is often a bare node; nothing to draw for it
            return None
        width = None
    else:
        return None
    properties = {"cmtype": "aeroway", "aeroway": kind, "width": width}
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }
