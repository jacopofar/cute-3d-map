"""Trees and tree rows.

Part of ``tilegen/features``: the trees and tree rows.
"""

import json
import logging
import zlib

import shapely

from tiles import TileFeature

from .common import parse_length

logger = logging.getLogger(__name__)


CONIFER_GENERA = (
    "pinus",
    "abies",
    "picea",
    "larix",
    "cedrus",
    "cupressus",
    "thuja",
    "juniperus",
    "taxus",
    "pseudotsuga",
)


def tree_type_size(tags, seed: int) -> tuple[str, float]:
    """(type, crown radius in meters) for a tree/row. Type comes from OSM tags
    (leaf_type, then genus/species) when present, otherwise from the seed."""
    leaf = str(tags.get("leaf_type", "")).lower()
    if leaf == "needleleaved":
        tree_type = "conifer"
    elif leaf == "broadleaved":
        tree_type = "broadleaf"
    else:
        species = f"{tags.get('genus', '')} {tags.get('species', '')}".lower()
        if any(genus in species for genus in CONIFER_GENERA):
            tree_type = "conifer"
        else:
            tree_type = "conifer" if seed % 3 == 0 else "broadleaf"

    crown = parse_length(tags.get("diameter_crown"))
    height = parse_length(tags.get("height"))
    if crown:
        size = crown / 2
    elif height:
        size = height * 0.25
    else:
        size = 1.3 + (seed % 7) * 0.12
    return tree_type, round(size, 2)


def to_tree(feature_id, tags, s) -> TileFeature | None:
    """Build a point tree feature."""
    if s.geom_type != "Point":
        logger.warning(f"non-point tree?? {feature_id}")
        return None
    tree_type, size = tree_type_size(tags, zlib.crc32(str(feature_id).encode()))
    properties = {"cmtype": "tree", "type": tree_type, "size": size}
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }


def to_tree_row(feature_id, tags, s) -> TileFeature | None:
    """Build a line tree-row feature."""
    if s.geom_type != "LineString":
        logger.warning(f"non-line tree_row?? {feature_id}")
        return None
    # a row shares one type/size; the frontend gives every sampled tree the
    # same values
    tree_type, size = tree_type_size(tags, zlib.crc32(str(feature_id).encode()))
    properties = {"cmtype": "tree_row", "type": tree_type, "size": size}
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {k: v for k, v in properties.items() if v is not None},
    }
