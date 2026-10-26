"""The static per-tile layers and the CLI flags that gate them.

pipeline is the assembly shell, so these tests stub the parquet loaders and
check the wiring: which layer each flag actually controls.
"""

import json
from pathlib import Path

import pytest
import shapely

import pipeline

PARQUET = Path("unused.parquet")
TILE = (1, 2)


@pytest.fixture
def loaders(monkeypatch):
    """Stub every loader so a test can turn one layer on and watch the rest."""
    monkeypatch.setattr(pipeline, "load_parking_ways", lambda _path: [])
    monkeypatch.setattr(pipeline, "load_cemetery_areas", lambda _path: [])
    monkeypatch.setattr(pipeline, "outside_cemeteries", lambda ways, _areas: ways)
    monkeypatch.setattr(pipeline, "load_footway_sidewalks", lambda _path: [])
    monkeypatch.setattr(pipeline, "sidewalk_centerlines", lambda _ways: [])
    monkeypatch.setattr(pipeline, "load_rooftop_accessories", lambda _path: ({}, set()))


def test_sidewalks_are_built_without_parking_or_lamps(monkeypatch, loaders):
    # sidewalks have no flag of their own, so both other layers being off must
    # not take them with it
    built: list[int] = []

    def polygons(centerlines, ways, zoom):
        built.append(zoom)
        return {TILE: [{"type": "feature"}]}

    monkeypatch.setattr(pipeline, "sidewalk_polygons_by_tile", polygons)
    monkeypatch.setattr(
        pipeline, "load_track_lines", lambda _path: pytest.fail("parking is off")
    )
    monkeypatch.setattr(
        pipeline, "parking_rows", lambda *_args: pytest.fail("parking is off")
    )
    monkeypatch.setattr(
        pipeline, "lamp_spots", lambda *_args: pytest.fail("lamps are off")
    )

    parking, sidewalks, _rooftop, _solar, lamps = pipeline._static_layers(
        PARQUET, 15, parking=False, lamps=False
    )

    assert built == [15]
    assert sidewalks == {TILE: [{"type": "feature"}]}
    assert parking == {}
    assert lamps == {}


def test_parking_does_not_build_lamps(monkeypatch, loaders):
    monkeypatch.setattr(pipeline, "sidewalk_polygons_by_tile", lambda *_: {})
    monkeypatch.setattr(pipeline, "load_track_lines", lambda _path: [])
    monkeypatch.setattr(pipeline, "parking_rows", lambda *_args: [])
    monkeypatch.setattr(pipeline, "parking_rows_by_tile", lambda *_args: {TILE: []})
    monkeypatch.setattr(
        pipeline, "lamp_spots", lambda *_args: pytest.fail("lamps are off")
    )

    parking, _sidewalks, _rooftop, _solar, lamps = pipeline._static_layers(
        PARQUET, 15, parking=True, lamps=False
    )

    assert parking == {TILE: []}
    assert lamps == {}


def test_write_tile_reads_its_blocks_back_from_the_payload(tmp_path):
    # the per-tile blocks used to arrive as four separately sliced arguments;
    # the payload is keyed by tile, so it alone decides what the document holds
    payload = pipeline.TilePayload(
        parking={TILE: [{"id": "row"}]},
        sidewalk={TILE: [{"type": "Feature", "properties": {"cmtype": "sidewalk"}}]},
        lamps={TILE: [[9.19, 45.497]]},
    )
    raw_root = tmp_path / "raw"

    pipeline._write_tile(
        *TILE,
        context=pipeline.TileContext(zoom=15),
        features=[],
        payload=payload,
        traffic_loops=None,
        target_folder=tmp_path,
        target_folder_raw=raw_root,
    )

    document = json.loads((tmp_path / str(TILE[0]) / f"{TILE[1]}.json").read_text())
    assert [f["properties"]["cmtype"] for f in document["features"]] == ["sidewalk"]
    assert document["parking"] == [{"id": "row"}]
    assert document["lamps"] == [[9.19, 45.497]]
    # no raw features means no raw twin, even when the folder was asked for
    assert not (raw_root / str(TILE[0]) / f"{TILE[1]}.json").exists()

    # a tile with no block of its own writes nothing: the keyed lookup must not
    # hand every tile the same rows
    pipeline._write_tile(
        9,
        9,
        context=pipeline.TileContext(zoom=15),
        features=[],
        payload=payload,
        traffic_loops=None,
        target_folder=tmp_path,
        target_folder_raw=None,
    )
    assert not (tmp_path / "9" / "9.json").exists()


def test_tile_to_geojson_reads_the_building_inputs_from_the_context():
    # the solar set is authored by the rooftop pass but read by the building
    # builder, so it has to survive the trip through the context
    building = shapely.to_wkb(shapely.box(9.19, 45.497, 9.1902, 45.4972))
    context = pipeline.TileContext(zoom=15, solar_buildings={"way/1"})
    render, _raw = pipeline.tile_to_geojson(
        [("way/1", {"building": "yes", "height": "12"}, building)],
        17220,
        11723,
        context=context,
    )
    assert render[0]["properties"]["solar"] is True
