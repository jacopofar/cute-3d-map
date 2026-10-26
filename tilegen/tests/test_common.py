"""The shared tag parsers. OSM values are user-entered strings, so the point of
these is the fallback: a value the parser cannot read must come back as None and
let the caller use its own default, never as a number that looks plausible."""

import pytest

from features.common import parse_length, parse_number


@pytest.mark.parametrize(
    ("value", "meters"),
    [
        ("12", 12.0),
        ("12.5", 12.5),
        ("12 m", 12.0),
        ("12m", 12.0),
        ("12 meters", 12.0),
        # a foot is not a meter, which is the bug this covers
        ("40 ft", 12.192),
        ("40 feet", 12.192),
        ("5'", 1.524),
        ("150 cm", 1.5),
        ("1500 mm", 1.5),
        ("1.2 km", 1200.0),
        # a comma is a decimal separator in a fair share of OSM tags
        ("12,5", 12.5),
        # an unknown suffix is a note, not a unit: keep the OSM default
        ("12 approx", 12.0),
    ],
)
def test_parse_length_converts_known_units_to_meters(value, meters):
    assert parse_length(value) == pytest.approx(meters)


@pytest.mark.parametrize("value", [None, "", "  ", "tall", "abc"])
def test_parse_length_rejects_values_with_no_number(value):
    assert parse_length(value) is None


def test_parse_length_reads_the_number_and_not_its_leading_junk():
    assert parse_length("about 12 m") == pytest.approx(12.0)


@pytest.mark.parametrize(
    ("value", "number"),
    [
        ("3", 3.0),
        ("-1", -1.0),
        ("380000", 380000.0),
        ("0;1", 0.0),
        # no unit conversion: a level or a voltage is not a length
        ("20 kV", 20.0),
        ("3 floors", 3.0),
    ],
)
def test_parse_number_takes_the_first_number_without_units(value, number):
    assert parse_number(value) == pytest.approx(number)


@pytest.mark.parametrize("value", [None, "", "none"])
def test_parse_number_rejects_values_with_no_number(value):
    assert parse_number(value) is None
