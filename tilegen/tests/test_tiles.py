"""The tile contract: every emitted feature has a documented shape, and the
builders do not grow property keys the schema does not know about.

The frontend reads these keys by hand, so a key added here without a matching
change there is a silent bug. This is the cheap half of that check: it catches
the tilegen side.
"""

import ast
import pathlib

import pytest
from shapely.geometry import Point

import features
from tiles import BY_CMTYPE


def schema_keys(cmtype: str) -> set[str]:
    """The property keys the contract allows for one cmtype."""
    schema = BY_CMTYPE[cmtype]
    return set(schema.__required_keys__) | set(schema.__optional_keys__)


def test_every_emitted_cmtype_is_documented():
    """No builder may emit a cmtype the contract has never heard of."""
    emitted: set[str] = set()
    for module in sorted(pathlib.Path("features").glob("*.py")):
        if module.name == "__init__.py":
            continue
        tree = ast.parse(module.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Dict):
                continue
            for key, value in zip(node.keys, node.values):
                if (
                    isinstance(key, ast.Constant)
                    and key.value == "cmtype"
                    and isinstance(value, ast.Constant)
                    and isinstance(value.value, str)
                ):
                    emitted.add(value.value)
    assert emitted <= set(BY_CMTYPE), emitted - set(BY_CMTYPE)


def test_the_point_builders_stay_inside_the_schema():
    """A handful of builders that need nothing but a point and some tags."""
    origin = Point(9.18, 45.5)
    cases = [
        ("tree", features.to_tree("node/1", {"leaf_type": "broadleaved"}, origin)),
        (
            "bench",
            features.to_bench(
                "node/2", {"amenity": "bench", "direction": "north"}, origin
            ),
        ),
        (
            "furniture",
            features.to_furniture(
                "node/3", {"amenity": "bench", "barrier": "bollard"}, origin
            ),
        ),
        (
            "monument",
            features.to_monument(
                "node/4", {"historic": "memorial", "name": "x"}, origin
            ),
        ),
        (
            "playground",
            features.to_playground("node/5", {"leisure": "playground"}, origin),
        ),
        (
            "fountain",
            features.to_fountain(
                "node/6", {"amenity": "fountain", "name": "x"}, origin
            ),
        ),
        (
            "transit_stop",
            features.to_transit_stop(
                "node/7", {"railway": "subway_entrance", "name": "x"}, origin
            ),
        ),
        (
            "gate",
            features.to_gate(8, {"barrier": "gate"}, origin, {8: 90.0}),
        ),
        ("traffic_signal", features.to_traffic_signal("node/9", {}, origin)),
        ("crossing", features.to_crossing("node/10", {}, origin)),
    ]
    for cmtype, feature in cases:
        assert feature is not None, cmtype
        assert feature["type"] == "feature"
        assert feature["properties"]["cmtype"] == cmtype
        unknown = set(feature["properties"]) - schema_keys(cmtype)
        assert not unknown, f"{cmtype} emits undocumented keys: {unknown}"


def test_the_building_builder_stays_inside_the_schema():
    from shapely.geometry import Polygon

    footprint = Polygon(
        [(9.18, 45.5), (9.1802, 45.5), (9.1802, 45.5002), (9.18, 45.5002)]
    )
    feature = features.to_building(
        "way/1", {"building": "yes", "height": "12", "name": "Casa"}, footprint
    )
    assert feature is not None
    unknown = set(feature["properties"]) - schema_keys("building")
    assert not unknown, f"building emits undocumented keys: {unknown}"


@pytest.mark.parametrize("cmtype", sorted(BY_CMTYPE))
def test_every_schema_starts_with_its_cmtype(cmtype: str):
    """The frontend switches on `cmtype`, so it is never dropped."""
    assert "cmtype" in BY_CMTYPE[cmtype].__required_keys__
