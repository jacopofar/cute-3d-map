import json

from gtfs_routes import geojson_collection, reverse_pairs


def test_geojson_collection_is_a_feature_collection():
    shapes = [
        {
            "shape_id": "a",
            "route_id": "R",
            "line": "1",
            "route": "one",
            "kind": "bus",
            "route_type": "bus",
            "color": None,
            "trip_count": 2,
            "directions": {"0": 2},
            "headsigns": ["A"],
            "coords": [(9.0, 45.0), (9.01, 45.0)],
            "length_m": 786.0,
            "closed": False,
        }
    ]
    collection = geojson_collection(shapes, {})
    assert collection["type"] == "FeatureCollection"
    assert len(collection["features"]) == 1
    assert collection["features"][0]["geometry"]["type"] == "LineString"
    json.dumps(collection)  # must be serializable


def test_reverse_pairs_marks_both_directions():
    base = {
        "route_id": "R",
        "line": "1",
        "route": "one",
        "kind": "bus",
        "route_type": "bus",
        "color": None,
        "trip_count": 1,
        "directions": {"0": 1},
        "headsigns": ["A"],
        "length_m": 1000.0,
        "closed": False,
    }
    shapes = [
        {**base, "shape_id": "a", "coords": [(9.0, 45.0), (9.01, 45.0)]},
        {**base, "shape_id": "b", "coords": [(9.01, 45.0), (9.0, 45.0)]},
    ]
    assert reverse_pairs(shapes) == {"a": "b", "b": "a"}
