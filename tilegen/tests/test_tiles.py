"""The tile contract: every emitted feature has a documented shape, and the
builders do not grow property keys the schema does not know about.

The frontend reads these keys by hand, so a key added here without a matching
change there is a silent bug. This is the cheap half of that check: it catches
the tilegen side.
"""

import ast
import pathlib

import pytest

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


def _builder_properties() -> dict[str, tuple[str, set[str]]]:
    """Every builder's cmtype and the property keys it emits, read statically.

    Reading the source instead of calling the builder is what lets this cover
    all of them: constructing valid sample geometry for every builder is the
    reason the old test checked only the ten that needed nothing but a Point,
    and six emitted keys had already slipped through that gap.

    A builder's property dict is the literal carrying `cmtype`; keys added
    afterwards (`properties["crane"] = True`) are collected too. A `**spread`
    is invisible here, which is why the building builder keeps its runtime
    test below.
    """
    found: dict[str, tuple[str, set[str]]] = {}
    modules = sorted(pathlib.Path("features").glob("*.py")) + sorted(
        pathlib.Path(".").glob("*.py")
    )
    for module in modules:
        if module.name == "__init__.py":
            continue
        tree = ast.parse(module.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef):
                continue
            cmtype: str | None = None
            keys: set[str] = set()
            for sub in ast.walk(node):
                if not isinstance(sub, ast.Assign):
                    continue
                target = sub.targets[0] if len(sub.targets) == 1 else None
                if (
                    isinstance(target, ast.Subscript)
                    and isinstance(target.value, ast.Name)
                    and target.value.id == "properties"
                    and isinstance(target.slice, ast.Constant)
                    and isinstance(target.slice.value, str)
                ):
                    keys.add(target.slice.value)
            for sub in ast.walk(node):
                if not isinstance(sub, ast.Dict):
                    continue
                literal = {
                    key.value: value
                    for key, value in zip(sub.keys, sub.values)
                    if isinstance(key, ast.Constant) and isinstance(key.value, str)
                }
                value = literal.get("cmtype")
                if not (
                    isinstance(value, ast.Constant) and isinstance(value.value, str)
                ):
                    continue
                cmtype = value.value
                keys.update(key for key in literal if key != "cmtype")
            if cmtype is not None:
                found[f"{module.name}:{node.name}"] = (cmtype, keys)
    return found


def test_every_builder_stays_inside_the_schema():
    """Every builder, not a hand-picked handful."""
    undocumented: dict[str, set[str]] = {}
    for name, (cmtype, keys) in _builder_properties().items():
        unknown = keys - schema_keys(cmtype)
        if unknown:
            undocumented[name] = unknown
    assert not undocumented, f"builders emit undocumented keys: {undocumented}"


def test_every_documented_cmtype_is_produced_by_a_builder():
    """A schema with no builder is dead weight, and usually a rename left over."""
    built = {cmtype for cmtype, _keys in _builder_properties().values()}
    # the two data-only stop points take their cmtype as a parameter, so the
    # static scan cannot see which values they emit
    outside = {"crossing", "traffic_signal"}
    assert built <= set(BY_CMTYPE)
    assert set(BY_CMTYPE) - built == outside


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
