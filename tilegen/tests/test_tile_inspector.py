import json

import click
import pytest

import tile_inspector


def test_parse_bbox_rejects_reversed_values():
    assert tile_inspector.parse_bbox("9.0,45.0,9.1,45.1") == (9.0, 45.0, 9.1, 45.1)
    with pytest.raises(click.BadParameter, match="min values"):
        tile_inspector.parse_bbox("9.1,45.0,9.0,45.1")


def test_style_for_park_path_uses_kind_and_surface():
    walk = {"properties": {"cmtype": "park_path", "kind": "walk"}}
    bike = {"properties": {"cmtype": "park_path", "kind": "bike"}}
    asphalt = {
        "properties": {"cmtype": "park_path", "kind": "walk", "surface": "asphalt"}
    }
    assert tile_inspector.style_for(walk)[1] == "#b58a5d"
    assert tile_inspector.style_for(bike)[1] == "#a85f4a"
    assert tile_inspector.style_for(asphalt)[1] == "#a6a39b"


def test_render_svg_and_png_draw_the_tile_features(tmp_path):
    features = [
        {
            "type": "Feature",
            "id": "way/1",
            "properties": {"cmtype": "building"},
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [9.0, 45.0],
                        [9.01, 45.0],
                        [9.01, 45.01],
                        [9.0, 45.01],
                        [9.0, 45.0],
                    ]
                ],
            },
        },
        {
            "type": "Feature",
            "id": "node/2",
            "properties": {"cmtype": "tree"},
            "geometry": {"type": "Point", "coordinates": [9.005, 45.005]},
        },
    ]
    svg = tile_inspector.render_svg(features, (9.0, 45.0, 9.01, 45.01), 400)
    assert "<svg" in svg
    assert tile_inspector.STYLE["building"] in svg
    assert "<circle" in svg
    png = tile_inspector.render_png(features, (9.0, 45.0, 9.01, 45.01), 400)
    assert png.startswith(b"\x89PNG")


def test_load_features_reads_the_tile_range(tmp_path):
    bbox = (9.0, 45.0, 9.01, 45.01)
    min_x, min_y, _max_x, _max_y = tile_inspector.tile_range(bbox)
    tile = tmp_path / str(min_x) / f"{min_y}.json"
    tile.parent.mkdir(parents=True)
    tile.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"cmtype": "water"},
                        "geometry": {
                            "type": "Point",
                            "coordinates": [9.005, 45.005],
                        },
                    }
                ],
            }
        )
    )
    features = tile_inspector.load_features(tmp_path, bbox)
    assert len(features) == 1
    assert features[0]["properties"]["cmtype"] == "water"


def test_every_cmtype_has_a_style_and_a_draw_order():
    """The inspector is the only place that sees every layer, so a new cmtype
    that falls through to the default gray is a silent hole in it."""
    from tiles import BY_CMTYPE

    assert set(BY_CMTYPE) - set(tile_inspector.STYLE) == set()
    assert set(tile_inspector.STYLE) <= set(tile_inspector.DRAW_ORDER)
