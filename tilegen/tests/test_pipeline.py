"""The static per-tile layers and the CLI flags that gate them.

pipeline is the assembly shell, so these tests stub the parquet loaders and
check the wiring: which layer each flag actually controls.
"""

from pathlib import Path

import pytest

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
