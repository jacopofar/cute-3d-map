"""Fill in the building tags that are missing by sampling what the dataset has.

Only a couple of percent of buildings carry `roof:shape`, `building:colour` or
`roof:colour`, so without this the tiles would be almost featureless. Rather than
a fixed default per field, a missing value is drawn from the distribution of the
values that *are* present, so a dataset whose roofs are 30% red yields 30% red
imputed roofs. The draw is seeded from the building's feature id, so a rebuild
reproduces the same tiles and diffs stay meaningful.

`traffic.py` does no OSM I/O; this module keeps the same contract -- it takes
plain counts and tag mappings.
"""

import random
import zlib
from bisect import bisect_right
from dataclasses import dataclass
from itertools import accumulate

# field name in the tile -> OSM tag it comes from
IMPUTED_FIELDS = (
    ("color", "building:colour"),
    ("roof_shape", "roof:shape"),
    ("roof_color", "roof:colour"),
)


@dataclass(frozen=True)
class Distribution:
    """A weighted set of observed values, sampled with `sample`."""

    values: tuple[str, ...]
    cumulative: tuple[int, ...]
    total: int

    @classmethod
    def from_counts(cls, counts: dict[str, int]) -> "Distribution | None":
        """None when there is nothing to sample (the tag is never set)."""
        items = [(str(value), int(count)) for value, count in counts.items() if count]
        if not items:
            return None
        cumulative = tuple(accumulate(count for _, count in items))
        return cls(
            values=tuple(value for value, _ in items),
            cumulative=cumulative,
            total=cumulative[-1],
        )

    def sample(self, rng: random.Random) -> str:
        return self.values[bisect_right(self.cumulative, rng.randrange(self.total))]


def building_seed(feature_id) -> int:
    """Stable per-building seed, so imputation is reproducible across runs."""
    return zlib.crc32(str(feature_id).encode())


def impute(
    tags,
    feature_id,
    distributions: dict[str, Distribution],
) -> tuple[dict[str, str], list[str]]:
    """The color, roof_shape and roof_color for one building: the real tag where
    present, else a sample from that field's distribution. Fields with no
    distribution (the tag never appears in the data) are left out. Returns the
    values and the fields that were sampled, so the frontend can tell an imputed
    value from a real one."""
    rng = random.Random(building_seed(feature_id))
    values: dict[str, str] = {}
    sampled: list[str] = []
    for field, tag in IMPUTED_FIELDS:
        real = tags.get(tag)
        if real is not None:
            values[field] = str(real)
            continue
        distribution = distributions.get(field)
        if distribution is not None:
            values[field] = distribution.sample(rng)
            sampled.append(field)
    return values, sampled
