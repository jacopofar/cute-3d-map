"""Benches, street furniture and outdoor terraces.

Part of ``tilegen/features``: the benches, street furniture and outdoor terraces.
"""

import logging

from shapely.geometry import Point

from tiles import TileFeature

from .common import COMPASS, as_point, feature, line_bearing

logger = logging.getLogger(__name__)


def bench_direction(tags) -> float | None:
    """The way a bench faces, in degrees clockwise from north, or None when the
    tag says nothing usable. "parallel"/"perpendicular" describe the bench
    relative to a nearby way that is not part of the data, so they are ignored,
    as is anything else that is not a compass letter or a number."""
    value = str(tags.get("direction", "")).strip().upper()
    if value in COMPASS:
        return COMPASS[value]
    try:
        return float(value) % 360
    except ValueError:
        return None


def to_bench(feature_id, tags, s) -> TileFeature | None:
    """A bench as a point render feature. A bench mapped as a way collapses to
    the midpoint of the line, with the facing taken along it; benches come in
    thousands, so the properties stay minimal (the frontend derives everything
    else)."""
    if s.geom_type not in ("Point", "LineString"):
        # one stray Polygon bench (and anything odder) must not abort the tile
        logger.warning(f"non-point/line bench?? {feature_id} ({s.geom_type})")
        return None
    direction = bench_direction(tags)
    if direction is None and s.geom_type == "LineString":
        direction = line_bearing(s)
    properties = {
        "cmtype": "bench",
        "direction": direction,
        # OSM's `colour` is the usual key; `color` also shows up in the wild.
        # The frontend validates both and falls back to its wooden brown.
        "colour": tags.get("colour"),
        "color": tags.get("color"),
    }
    return feature(feature_id, as_point(s), properties)


# small street furniture: one point per object, so the frontend can build a
# low-poly prop and merge the tile's props into one mesh. Bench is handled
# separately (it carries a direction); these are the anonymous pieces.
FURNITURE_KINDS = (
    ("barrier", "bollard", "bollard"),
    ("amenity", "waste_basket", "bin"),
    ("amenity", "bicycle_parking", "bike_rack"),
    ("amenity", "post_box", "post_box"),
    ("amenity", "drinking_water", "drinking_water"),
    ("tourism", "information", "info_board"),
    ("emergency", "fire_hydrant", "hydrant"),
)


def furniture_kind(tags) -> str | None:
    """The prop kind a street-furniture tag wants, or None."""
    for key, value, kind in FURNITURE_KINDS:
        if tags.get(key) == value:
            return kind
    return None


# food/drink places whose outdoor seating we can turn into a terrace; a stray
# pharmacy or bench with the tag is not a cafe
TERRACE_AMENITIES = frozenset(
    {"restaurant", "cafe", "bar", "pub", "fast_food", "ice_cream", "biergarten"}
)


def is_terrace(tags) -> bool:
    value = tags.get("outdoor_seating")
    return (
        value is not None and value != "no" and tags.get("amenity") in TERRACE_AMENITIES
    )


def terrace_place(point, road, building_tree, buildings, offset_max: float = 8.0):
    """Move a terrace from the cafe point to the nearest point by the road that
    is not inside a building. OSM often puts the cafe node inside the building;
    a small step toward the cafe from the road stays at the kerb only until the
    facade starts, so test candidates from the widest inward step and take the
    first one outside every footprint."""
    nearest = road.interpolate(road.project(point))
    distance = point.distance(nearest)
    if distance < 1e-6:
        return nearest
    ux = (point.x - nearest.x) / distance
    uy = (point.y - nearest.y) / distance
    candidates = [offset_max, 7.0, 6.0, 5.0, 4.0, 3.0, 2.0, 1.5, 1.0, 0.5]
    for offset in candidates:
        if offset > distance:
            continue
        candidate = Point(nearest.x + ux * offset, nearest.y + uy * offset)
        hits = building_tree.query(candidate)
        if not any(buildings[int(index)].contains(candidate) for index in hits):
            return candidate
    return nearest


def to_terrace(feature_id, tags, s, position=None) -> TileFeature | None:
    """An outdoor terrace as a point. The umbrellas/tables are procedural; the
    amenity value only picks the popup label and the OSM link. `position` is the
    precomputed sidewalk point (see terrace_positions_from_parquet)."""
    if not is_terrace(tags):
        return None
    point = Point(position) if position is not None else as_point(s)
    if point is None or point.is_empty:
        return None
    properties = {"cmtype": "terrace", "terrace": tags["amenity"]}
    if tags.get("name"):
        properties["name"] = tags["name"]
    return feature(feature_id, point, properties)


def to_furniture(feature_id, tags, s) -> TileFeature | None:
    """A street-furniture point. Areas (bike parking) collapse to their
    centroid; a line (a rack mapped as a way) keeps its bearing so the frontend
    can line the rack up with the kerb."""
    kind = furniture_kind(tags)
    if kind is None:
        return None
    point = as_point(s)
    if point is None:
        return None
    angle = line_bearing(s) if s.geom_type == "LineString" else None
    if point.is_empty:
        return None
    properties = {"cmtype": "furniture", "furniture": kind}
    if angle is not None:
        properties["angle"] = round(angle, 4)
    return feature(feature_id, point, properties)
