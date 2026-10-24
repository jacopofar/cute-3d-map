"""Flat SVG/raster inspector for the generated tiles.

This is deliberately not a map: it draws the tile payload as logical layers,
with one flat color per ``cmtype`` and no basemap, lighting, shadows or 3D
decoration. It is for answering "is this feature in the tile, and where?".
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

import click

from geo import TILE_ZOOM, coord_to_tile

Point = tuple[float, float]
Ring = list[Point]

# logical fill/stroke colors; no data colors or lighting are used
STYLE: dict[str, str] = {
    "green": "#9fca78",
    "water": "#4c9ec9",
    "cemetery": "#9da98b",
    "building": "#c9b8a6",
    "construction": "#c49a66",
    "sidewalk": "#dedbd2",
    "park_path": "#b58a5d",
    "platform": "#b7b3aa",
    "rail": "#555a5e",
    "bridge": "#8b8d8c",
    "tree": "#4f8a48",
    "tree_row": "#4f8a48",
    "furniture": "#e59a3a",
    "fountain": "#5db7d8",
    "transit_stop": "#d45b4f",
    "terrace": "#d98ba4",
    "playground": "#e8c84d",
    "monument": "#c7a444",
    # white paint is invisible on the inspector's light canvas; use a dark
    # logical ink instead
    "crosswalk": "#3f3f3f",
    "road_marking": "#4a4a4a",
    "power_tower": "#41474b",
    "power_line": "#41474b",
    "wall": "#6d655e",
    "gate": "#a36b3f",
    "fence": "#7a756c",
    "rooftop": "#d08a45",
    "aeroway": "#a7a7a2",
    "bench": "#9a6d43",
    "traffic_signal": "#d24d4d",
    "crossing": "#f0f0f0",
    "tunnel": "#34383b",
}
DEFAULT_COLOR = "#888888"

# back to front: ground and areas, then structures, then lines and points
DRAW_ORDER = {
    "green": 0,
    "water": 1,
    "cemetery": 2,
    "sidewalk": 3,
    "park_path": 4,
    "platform": 5,
    "rail": 6,
    "bridge": 7,
    "aeroway": 8,
    "building": 9,
    "construction": 10,
    "tree": 11,
    "tree_row": 12,
    "power_line": 13,
    "power_tower": 14,
    "wall": 15,
    "fence": 16,
    "gate": 17,
    "bench": 18,
    "furniture": 19,
    "fountain": 20,
    "transit_stop": 21,
    "terrace": 22,
    "playground": 23,
    "monument": 24,
    "rooftop": 25,
    "crosswalk": 26,
    "road_marking": 27,
    "traffic_signal": 28,
    "crossing": 29,
    "tunnel": 30,
}


@dataclass
class Shape:
    """A flat drawable: polygon rings, a polyline, or one or more points."""

    kind: str
    color: str
    points: list[Point]
    rings: list[Ring] | None = None
    width: float = 1.0


def parse_bbox(text: str) -> tuple[float, float, float, float]:
    """Parse and validate a ``min_lon,min_lat,max_lon,max_lat`` string."""
    values = [float(part.strip()) for part in text.split(",")]
    if len(values) != 4:
        raise click.BadParameter("expected min_lon,min_lat,max_lon,max_lat")
    min_lon, min_lat, max_lon, max_lat = values
    if min_lon >= max_lon or min_lat >= max_lat:
        raise click.BadParameter("bbox min values must be below max values")
    return min_lon, min_lat, max_lon, max_lat


def world_point(lon: float, lat: float) -> Point:
    """Normalized Web Mercator coordinates, y down."""
    n = 2**TILE_ZOOM
    x = (lon + 180.0) / 360.0 * n
    y = (
        (
            1.0
            - math.log(math.tan(math.radians(lat)) + 1.0 / math.cos(math.radians(lat)))
            / math.pi
        )
        / 2.0
        * n
    )
    return x, y


def tile_range(bbox: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    """The inclusive tile range covered by a lon/lat bbox."""
    min_lon, min_lat, max_lon, max_lat = bbox
    min_x, min_y = coord_to_tile(min_lon, max_lat, TILE_ZOOM)
    max_x, max_y = coord_to_tile(max_lon, min_lat, TILE_ZOOM)
    return min_x, min_y, max_x, max_y


def load_features(
    tiles_dir: Path, bbox: tuple[float, float, float, float]
) -> list[dict]:
    features: list[dict] = []
    min_x, min_y, max_x, max_y = tile_range(bbox)
    for x in range(min_x, max_x + 1):
        for y in range(min_y, max_y + 1):
            path = tiles_dir / str(x) / f"{y}.json"
            if not path.exists():
                continue
            try:
                document = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            features.extend(document.get("features", []))
    return features


def style_for(feature: dict) -> tuple[str, str]:
    """(kind, color) for one tile feature, with a small park-path override."""
    props = feature.get("properties") or {}
    cmtype = props.get("cmtype")
    if cmtype == "park_path":
        surface = str(props.get("surface") or "").split(";")[0]
        if surface in ("asphalt", "concrete", "paved", "paving_stones", "sett"):
            return cmtype, "#a6a39b"
        if surface in ("gravel", "compacted", "fine_gravel", "ground", "dirt"):
            return cmtype, "#b28c61"
        return cmtype, "#b58a5d" if props.get("kind") != "bike" else "#a85f4a"
    return cmtype or "other", STYLE.get(cmtype or "", DEFAULT_COLOR)


def _positions(coords: Iterable[Sequence[float]]) -> list[Point]:
    return [(float(c[0]), float(c[1])) for c in coords]


def feature_shapes(feature: dict) -> list[Shape]:
    """Turn one GeoJSON feature into the flat shapes the renderers consume."""
    cmtype, color = style_for(feature)
    geom = feature.get("geometry") or {}
    kind = geom.get("type")
    coords = geom.get("coordinates") or []
    if kind == "Point":
        return [Shape("point", color, _positions([coords]))]
    if kind == "MultiPoint":
        return [Shape("point", color, _positions(coords))]
    if kind == "LineString":
        return [Shape("line", color, _positions(coords))]
    if kind == "MultiLineString":
        return [Shape("line", color, _positions(line)) for line in coords]
    if kind == "Polygon":
        return [Shape("polygon", color, [], [_positions(ring) for ring in coords])]
    if kind == "MultiPolygon":
        return [
            Shape("polygon", color, [], [_positions(ring) for ring in polygon])
            for polygon in coords
        ]
    if cmtype == "tree":
        return [Shape("point", color, _positions([coords]))]
    return []


def _projection(
    bbox: tuple[float, float, float, float], width: int
) -> tuple[int, Callable[[float, float], Point]]:
    """Return the output height and a lon/lat -> pixel projector."""
    min_world = world_point(bbox[0], bbox[3])
    max_world = world_point(bbox[2], bbox[1])
    span_x = max_world[0] - min_world[0]
    span_y = max_world[1] - min_world[1]
    height = max(1, round(width * span_y / span_x))
    scale = width / span_x

    def project(lon: float, lat: float) -> Point:
        x, y = world_point(lon, lat)
        return (x - min_world[0]) * scale, (y - min_world[1]) * scale

    return height, project


def _ordered(features: list[dict]) -> list[dict]:
    return sorted(
        features,
        key=lambda f: DRAW_ORDER.get((f.get("properties") or {}).get("cmtype"), 99),
    )


def _svg_path(rings: list[Ring], project) -> str:
    commands: list[str] = []
    for ring in rings:
        if len(ring) < 2:
            continue
        x, y = project(*ring[0])
        commands.append(f"M {x:.2f} {y:.2f}")
        commands.extend(
            f"L {x:.2f} {y:.2f}" for x, y in (project(*point) for point in ring[1:])
        )
        commands.append("Z")
    return " ".join(commands)


def render_svg(
    features: list[dict],
    bbox: tuple[float, float, float, float],
    width: int = 1600,
    legend: bool = False,
) -> str:
    """Render features as a standalone flat SVG document."""
    height, project = _projection(bbox, width)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#f5f4ef"/>',
    ]
    for feature in _ordered(features):
        for shape in feature_shapes(feature):
            if shape.kind == "polygon" and shape.rings:
                parts.append(
                    f'<path d="{_svg_path(shape.rings, project)}" '
                    f'fill="{shape.color}" fill-rule="evenodd"/>'
                )
            elif shape.kind == "line" and len(shape.points) >= 2:
                path = " ".join(
                    f"{'M' if i == 0 else 'L'} {x:.2f} {y:.2f}"
                    for i, (x, y) in enumerate(
                        project(*point) for point in shape.points
                    )
                )
                parts.append(
                    f'<path d="{path}" fill="none" stroke="{shape.color}" '
                    f'stroke-width="{shape.width}" stroke-linecap="round" '
                    f'stroke-linejoin="round"/>'
                )
            elif shape.kind == "point":
                for lon, lat in shape.points:
                    x, y = project(lon, lat)
                    parts.append(
                        f'<circle cx="{x:.2f}" cy="{y:.2f}" r="2.5" '
                        f'fill="{shape.color}"/>'
                    )
    if legend:
        parts.extend(_svg_legend(width, height))
    parts.append("</svg>")
    return "\n".join(parts)


LEGEND_ITEMS = [
    ("building", STYLE["building"]),
    ("water", STYLE["water"]),
    ("green", STYLE["green"]),
    ("tree", STYLE["tree"]),
    ("park path", STYLE["park_path"]),
    ("sidewalk", STYLE["sidewalk"]),
    ("crosswalk", STYLE["crosswalk"]),
    ("power", STYLE["power_line"]),
]


def _svg_legend(width: int, height: int) -> list[str]:
    items = LEGEND_ITEMS
    x = 16
    y = height - 18 * len(items) - 12
    out = [
        (
            f'<rect x="{x - 6}" y="{y - 10}" width="150" '
            f'height="{18 * len(items) + 8}" fill="white" opacity="0.8"/>'
        )
    ]
    for label, color in items:
        out.append(f'<rect x="{x}" y="{y - 8}" width="10" height="10" fill="{color}"/>')
        out.append(
            f'<text x="{x + 16}" y="{y + 1}" font-size="11" fill="#333">{label}</text>'
        )
        y += 18
    return out


def render_png(
    features: list[dict],
    bbox: tuple[float, float, float, float],
    width: int = 1600,
    legend: bool = False,
) -> bytes:
    """Render features as a PNG; requires Pillow."""
    try:
        from PIL import Image, ImageDraw
    except ImportError as error:  # pragma: no cover - optional dependency
        raise click.ClickException(
            "PNG output needs Pillow: run `uv add pillow` in tilegen/"
        ) from error
    height, project = _projection(bbox, width)
    image = Image.new("RGB", (width, height), "#f5f4ef")
    draw = ImageDraw.Draw(image)
    for feature in _ordered(features):
        for shape in feature_shapes(feature):
            if shape.kind == "polygon" and shape.rings:
                if not shape.rings[0]:
                    continue
                draw.polygon(
                    [project(*point) for point in shape.rings[0]],
                    fill=shape.color,
                )
                for hole in shape.rings[1:]:
                    draw.polygon([project(*point) for point in hole], fill="#f5f4ef")
            elif shape.kind == "line" and len(shape.points) >= 2:
                draw.line(
                    [project(*point) for point in shape.points],
                    fill=shape.color,
                    width=max(1, round(shape.width)),
                    joint="curve",
                )
            elif shape.kind == "point":
                for lon, lat in shape.points:
                    px, py = project(lon, lat)
                    draw.ellipse((px - 2, py - 2, px + 2, py + 2), fill=shape.color)
    if legend:
        items = LEGEND_ITEMS
        x = 16
        y = height - 18 * len(items) - 12
        draw.rectangle(
            (x - 6, y - 10, x + 144, y + 18 * len(items) - 2),
            fill="#ffffff",
        )
        for label, color in items:
            draw.rectangle((x, y - 8, x + 10, y + 2), fill=color)
            draw.text((x + 16, y - 8), label, fill="#333333")
            y += 18
    from io import BytesIO

    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


@click.command()
@click.option(
    "--tiles",
    "tiles_dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=Path("../public/tiles"),
    show_default=True,
    help="Directory containing the generated {x}/{y}.json tiles.",
)
@click.option(
    "--bbox",
    required=True,
    help="Area to render: min_lon,min_lat,max_lon,max_lat.",
)
@click.option(
    "--output",
    type=click.Path(dir_okay=False, path_type=Path),
    default=Path("tiles.svg"),
    show_default=True,
    help="Output file; .svg or .png selects the renderer.",
)
@click.option("--width", type=click.IntRange(min=100), default=1600, show_default=True)
@click.option("--legend/--no-legend", default=False, help="Draw a small color key.")
def main(tiles_dir: Path, bbox: str, output: Path, width: int, legend: bool) -> None:
    """Render an area of tiles as flat SVG or PNG layers."""
    area = parse_bbox(bbox)
    features = load_features(tiles_dir, area)
    if output.suffix.lower() == ".png":
        output.write_bytes(render_png(features, area, width, legend))
    else:
        output.write_text(render_svg(features, area, width, legend))
    click.echo(f"{len(features)} features -> {output}")


if __name__ == "__main__":
    main()
