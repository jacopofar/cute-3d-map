import json

import pytest

from city import CityError, CityProfile, load_city
from features import BuildingOverride, to_building


def _write_city(path, city=None, buildings=None, vehicles=None, areas=None):
    path.mkdir(exist_ok=True)
    (path / "city.json").write_text(json.dumps(city or {"name": "Test"}))
    (path / "buildings.json").write_text(json.dumps(buildings or {}))
    (path / "vehicles.json").write_text(json.dumps(vehicles or {}))
    if areas is not None:
        (path / "areas.geojson").write_text(json.dumps(areas))


def test_empty_city_keeps_defaults():
    profile = load_city(None)
    assert profile.name == "Milan"
    assert profile.building_override("way/1", {}) is None
    assert profile.vehicle_color({"line": "1"}) is None


def test_city_building_and_vehicle_overrides(tmp_path):
    _write_city(
        tmp_path,
        buildings={
            "by_id": {
                "way/1": {
                    "color": "#112233",
                    "roof_shape": "gabled",
                    "facade": {"windows": False, "balconies": True},
                }
            },
            "by_name": {"Duomo": {"color": "445566"}},
        },
        vehicles={"by_line": {"1": "#f2c94c"}},
    )
    profile = load_city(tmp_path)
    by_id = profile.building_override("way/1", {})
    assert by_id is not None
    assert by_id.color == "#112233"
    assert by_id.facade == {"windows": False, "balconies": True}
    by_name = profile.building_override("way/2", {"name": "Duomo"})
    assert by_name is not None
    assert by_name.color == "#445566"
    assert profile.vehicle_color({"line": "1"}) == "f2c94c"


def test_model_override_is_validated(tmp_path):
    _write_city(
        tmp_path,
        buildings={
            "by_id": {
                "way/1": {
                    "model": {
                        "file": "assets/model.glb",
                        "scale": 1.2,
                        "rotation": 15,
                        "offset": [1, 2, 3],
                    }
                }
            }
        },
    )
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "model.glb").write_bytes(b"glTF")
    profile = load_city(tmp_path)
    override = profile.building_override("way/1", {})
    assert override is not None
    assert override.model is not None
    assert override.model.file == "assets/model.glb"
    assert override.model.scale == 1.2
    assert override.model.offset == (1.0, 2.0, 3.0)


def test_missing_model_asset_fails(tmp_path):
    _write_city(
        tmp_path,
        buildings={"by_id": {"way/1": {"model": {"file": "assets/missing.glb"}}}},
    )
    with pytest.raises(CityError, match="missing model asset"):
        load_city(tmp_path)


def test_area_override_applies_by_polygon(tmp_path):
    import shapely

    _write_city(
        tmp_path,
        areas={
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"color": "#f4f4f4", "roof_color": "#ffffff"},
                    "geometry": json.loads(
                        shapely.to_geojson(shapely.box(9.0, 45.0, 9.01, 45.01))
                    ),
                }
            ],
        },
    )
    profile = load_city(tmp_path)
    inside = profile.building_override(
        "way/2", {}, shapely.box(9.002, 45.002, 9.003, 45.003)
    )
    assert inside is not None
    assert inside.color == "#f4f4f4"
    assert (
        profile.building_override("way/3", {}, shapely.box(9.1, 45.1, 9.11, 45.11))
        is None
    )


def test_invalid_city_color_fails(tmp_path):
    _write_city(tmp_path, buildings={"by_id": {"way/1": {"color": "red"}}})
    with pytest.raises(CityError, match="color"):
        load_city(tmp_path)


def test_pipeline_applies_city_building_override():
    import shapely

    from pipeline import tile_to_geojson

    city = CityProfile(building_by_id={"way/1": BuildingOverride(color="#112233")})
    render, _raw = tile_to_geojson(
        [
            (
                "way/1",
                {"building": "yes", "height": "12"},
                shapely.to_wkb(shapely.box(9.0, 45.0, 9.001, 45.001)),
            )
        ],
        17220,
        11723,
        15,
        city=city,
    )
    assert render[0]["properties"]["color"] == "#112233"


def test_building_override_wins_and_removes_imputed_marker():
    override = BuildingOverride(color="#112233", roof_shape="gabled")
    feature = to_building(
        1,
        {"building": "yes", "height": "12"},
        __import__("shapely").box(9.0, 45.0, 9.001, 45.001),
        override=override,
    )
    assert feature is not None
    assert feature["properties"]["color"] == "#112233"
    assert feature["properties"]["roof_shape"] == "gabled"
    assert "color" not in feature["properties"].get("imputed", [])
