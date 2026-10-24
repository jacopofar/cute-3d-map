"""Export GTFS bus/tram route shapes as GeoJSON, with a small text summary.

This is a diagnostic companion to ``gtfs.py``: it does not build traffic, it
just lets us see which shapes are directional, which are already paired, and
which carry no direction_id. Run it before deciding how to treat GTFS shapes in
the traffic generator.
"""

import json
from collections import Counter, defaultdict
from pathlib import Path

import click
from gtfs import read_route_shapes
from traffic import haversine_m


def reverse_pairs(shapes: list[dict]) -> dict[str, str]:
    """Map shape ids to a same-route shape that is its reverse, when close.

    GTFS often has two shapes for the two directions of the same line. Mirroring
    both would duplicate the route, so the diagnostic flags those pairs.
    """
    by_route: dict[str, list[dict]] = defaultdict(list)
    for shape in shapes:
        if shape["route_id"]:
            by_route[shape["route_id"]].append(shape)
    pairs: dict[str, str] = {}
    for route_shapes in by_route.values():
        for index, first in enumerate(route_shapes):
            a = first["coords"]
            if len(a) < 2:
                continue
            for second in route_shapes[index + 1 :]:
                b = second["coords"]
                if len(b) < 2:
                    continue
                same_ends = (
                    haversine_m(a[0], b[-1]) < 30 and haversine_m(a[-1], b[0]) < 30
                )
                close_length = abs(first["length_m"] - second["length_m"]) < max(
                    20, first["length_m"] * 0.05
                )
                if same_ends and close_length:
                    pairs[first["shape_id"]] = second["shape_id"]
                    pairs[second["shape_id"]] = first["shape_id"]
    return pairs


def summary(shapes: list[dict], pairs: dict[str, str]) -> str:
    direction_counts = Counter(tuple(sorted(shape["directions"])) for shape in shapes)
    blank = sum(1 for shape in shapes if "" in shape["directions"])
    closed = sum(1 for shape in shapes if shape["closed"])
    routes = {shape["route_id"] for shape in shapes if shape["route_id"]}
    route_shape_counts = Counter(
        shape["route_id"] for shape in shapes if shape["route_id"]
    )
    multi = sum(1 for count in route_shape_counts.values() if count > 1)
    lines = [
        "# GTFS route shapes",
        "",
        f"- Shapes: {len(shapes)}",
        f"- Routes: {len(routes)}",
        f"- Shapes with blank direction_id: {blank}",
        f"- Closed shapes: {closed}",
        f"- Reverse pairs: {len(pairs) // 2}",
        f"- Routes with more than one shape: {multi}",
        "",
        "## Direction fields",
        "",
    ]
    for fields, count in sorted(direction_counts.items()):
        lines.append(f"- `{fields}`: {count} shapes")
    lines.extend(["", "## By mode", ""])
    for kind, count in sorted(Counter(s["kind"] for s in shapes).items()):
        lines.append(f"- {kind}: {count} shapes")
    lines.extend(
        [
            "",
            "## Reading the result",
            "",
            "Shapes with a reverse partner are already directional pairs; they should",
            "not be mirrored again. Shapes without a partner and with a blank",
            "direction_id are the ambiguous ones to inspect in the GeoJSON.",
        ]
    )
    return "\n".join(lines) + "\n"


def geojson_collection(shapes: list[dict], pairs: dict[str, str]) -> dict:
    """Build a valid FeatureCollection from route shapes and reverse pairs."""
    features = []
    for shape in shapes:
        props = {
            "shape_id": shape["shape_id"],
            "route_id": shape["route_id"],
            "line": shape["line"],
            "route": shape["route"],
            "kind": shape["kind"],
            "route_type": shape["route_type"],
            "color": shape["color"],
            "trip_count": shape["trip_count"],
            "directions": shape["directions"],
            "headsigns": shape["headsigns"],
            "length_km": round(shape["length_m"] / 1000, 3),
            "closed": shape["closed"],
            "reverse_of": pairs.get(shape["shape_id"]),
        }
        features.append(
            {
                "type": "Feature",
                "id": shape["shape_id"],
                "properties": props,
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[lon, lat] for lon, lat in shape["coords"]],
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def write_gtfs_route_report(gtfs_path: Path, report_dir: Path) -> tuple[Path, Path]:
    """Write the GTFS route GeoJSON and summary into a tilegen report dir."""
    shapes = read_route_shapes(gtfs_path)
    pairs = reverse_pairs(shapes)
    collection = geojson_collection(shapes, pairs)
    report_dir.mkdir(parents=True, exist_ok=True)
    geojson_path = report_dir / "gtfs-routes.geojson"
    summary_path = report_dir / "gtfs-routes.md"
    geojson_path.write_text(json.dumps(collection, indent=2) + "\n")
    summary_path.write_text(summary(shapes, pairs))
    return geojson_path, summary_path


@click.command()
@click.option(
    "--gtfs",
    "gtfs_path",
    required=True,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="GTFS zip to inspect.",
)
@click.option(
    "--output",
    type=click.Path(dir_okay=False, path_type=Path),
    default=Path("gtfs-routes.geojson"),
    show_default=True,
    help="GeoJSON output; one feature per shape.",
)
@click.option(
    "--summary",
    "summary_path",
    type=click.Path(dir_okay=False, path_type=Path),
    default=Path("gtfs-routes.md"),
    show_default=True,
    help="Markdown summary output.",
)
def main(gtfs_path: Path, output: Path, summary_path: Path) -> None:
    """Export GTFS route shapes and print their direction situation."""
    # Keep the standalone CLI behaviour: explicit output paths win.
    shapes = read_route_shapes(gtfs_path)
    pairs = reverse_pairs(shapes)
    collection = geojson_collection(shapes, pairs)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(collection, indent=2) + "\n")
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(summary(shapes, pairs))
    click.echo(f"{len(collection['features'])} shapes -> {output}")
    click.echo(f"summary -> {summary_path}")


if __name__ == "__main__":
    main()
