"""Power towers and overhead lines.

Part of ``tilegen/features``: the power towers and overhead lines.
"""

import json

import shapely

from tiles import TileFeature

from .common import parse_length, parse_number

POWER_LINE_KINDS = frozenset({"line", "minor_line"})


def is_power_line(tags) -> bool:
    """An overhead power line. Underground sections and cable tunnels are not
    drawn: they have no pylon silhouette in the 3D view."""
    return (
        tags.get("power") in POWER_LINE_KINDS
        and tags.get("location") != "underground"
        and tags.get("tunnel") not in ("yes", "building_passage")
    )


def power_wire_height(tags) -> float:
    """Approximate wire height from voltage, since OSM rarely tags line height.
    The tower default is 25 m; these keep the spans near the crossarms."""
    voltage = parse_number(tags.get("voltage"))
    if voltage is None:
        return 20.0
    if voltage >= 380_000:
        return 26.0
    if voltage >= 220_000:
        return 23.0
    if voltage >= 132_000:
        return 19.0
    return 16.0


def to_power_tower(feature_id, tags, s) -> TileFeature | None:
    """Build a power-tower point feature."""
    if s.geom_type != "Point":
        return None
    return {
        "type": "feature",
        "id": feature_id,
        "geometry": json.loads(shapely.to_geojson(s)),
        "properties": {
            "cmtype": "power_tower",
            "height": parse_length(tags.get("height")) or 30.0,
            "name": tags.get("name"),
            "operator": tags.get("operator"),
            "ref": tags.get("ref"),
        },
    }


def to_power_line(feature_id, tags, s, tile_box) -> list[TileFeature]:
    """Clip one overhead line to the tile; the frontend draws the catenary."""
    if not is_power_line(tags) or s.geom_type not in ("LineString", "MultiLineString"):
        return []
    clipped = s.intersection(tile_box)
    features: list[TileFeature] = []
    for part in shapely.get_parts(clipped):
        if part.geom_type != "LineString" or part.length < 1e-5:
            continue
        properties = {
            "cmtype": "power_line",
            "height": power_wire_height(tags),
            "voltage": tags.get("voltage"),
            "cables": tags.get("cables"),
            "wires": tags.get("wires"),
            "name": tags.get("name"),
            "ref": tags.get("ref"),
            "operator": tags.get("operator"),
        }
        features.append(
            {
                "type": "feature",
                "id": feature_id,
                "geometry": json.loads(shapely.to_geojson(part)),
                "properties": {
                    key: value for key, value in properties.items() if value is not None
                },
            }
        )
    return features
