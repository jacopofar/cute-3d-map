import collections
import random

import impute
import pytest
from impute import Distribution


def dist(counts: dict[str, int]) -> Distribution:
    """`from_counts` returns None when there is nothing to sample; every call
    here passes something, so narrow it for the type checker."""
    distribution = Distribution.from_counts(counts)
    assert distribution is not None
    return distribution


def test_from_counts_none_when_nothing_to_sample():
    assert Distribution.from_counts({}) is None
    assert Distribution.from_counts({"red": 0}) is None


def test_sample_follows_the_observed_distribution():
    distribution = dist({"red": 300, "blue": 700})
    rng = random.Random(0)
    draws = collections.Counter(distribution.sample(rng) for _ in range(10_000))
    # 30% red in the data -> about 30% red out of the sampler
    assert draws["red"] == pytest.approx(3000, rel=0.1)
    assert draws["blue"] == pytest.approx(7000, rel=0.1)


def test_sample_spans_every_value():
    distribution = dist({"a": 1, "b": 1, "c": 1})
    rng = random.Random(1)
    assert {distribution.sample(rng) for _ in range(50)} == {"a", "b", "c"}


def test_impute_keeps_the_real_tags():
    distributions = {
        "color": dist({"red": 1}),
        "roof_shape": dist({"gabled": 1}),
        "roof_color": dist({"black": 1}),
    }
    tags = {
        "building": "yes",
        "building:colour": "white",
        "roof:shape": "hipped",
        "roof:colour": "green",
    }
    values, sampled = impute.impute(tags, "way/1", distributions)
    assert values == {
        "color": "white",
        "roof_shape": "hipped",
        "roof_color": "green",
    }
    assert sampled == []


def test_impute_fills_only_what_is_missing():
    distributions = {
        "color": dist({"red": 1}),
        "roof_shape": dist({"gabled": 1}),
    }
    values, sampled = impute.impute({"building": "yes"}, "way/2", distributions)
    assert values == {"color": "red", "roof_shape": "gabled"}
    assert sorted(sampled) == ["color", "roof_shape"]


def test_impute_leaves_a_field_out_when_the_tag_never_occurs():
    assert impute.impute({"building": "yes"}, "way/3", {}) == ({}, [])


def test_impute_is_reproducible_per_building():
    distributions = {"color": dist({"red": 5, "blue": 3, "gold": 2})}
    first = impute.impute({"building": "yes"}, "way/42", distributions)
    second = impute.impute({"building": "yes"}, "way/42", distributions)
    assert first == second
    # a different building is free to land on a different value
    others = {
        impute.impute({"building": "yes"}, f"way/{i}", distributions)[0]["color"]
        for i in range(50)
    }
    assert len(others) > 1
