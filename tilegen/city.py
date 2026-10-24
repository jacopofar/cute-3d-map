"""Optional city profile: file-driven overrides for a port of the map.

The profile is deliberately small and data-only. tilegen reads it once, applies
building and vehicle overrides while building tiles, and otherwise leaves the
Milan defaults untouched.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry

logger = logging.getLogger(__name__)

COLOR_RE = re.compile(r"^#?[0-9a-fA-F]{6}$")


class CityError(ValueError):
    """A malformed city profile or override."""


def _color(value: object, where: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not COLOR_RE.fullmatch(value):
        raise CityError(f"{where}: expected a #rrggbb color, got {value!r}")
    return value if value.startswith("#") else f"#{value}"


def _optional_bool(value: object, where: str) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        raise CityError(f"{where}: expected true or false, got {value!r}")
    return value


@dataclass(frozen=True)
class BuildingOverride:
    color: str | None = None
    roof_color: str | None = None
    roof_shape: str | None = None
    windows: bool | None = None
    balconies: bool | None = None

    @property
    def facade(self) -> dict[str, bool] | None:
        flags = {}
        if self.windows is not None:
            flags["windows"] = self.windows
        if self.balconies is not None:
            flags["balconies"] = self.balconies
        return flags or None


@dataclass(frozen=True)
class CityProfile:
    name: str = "Milan"
    directory: Path | None = None
    building_by_id: dict[str, BuildingOverride] | None = None
    building_by_name: dict[str, BuildingOverride] | None = None
    vehicle_by_line: dict[str, str] | None = None
    vehicle_by_route: dict[str, str] | None = None
    area_overrides: list[tuple[BaseGeometry, BuildingOverride]] | None = None
    asset_base: str | None = None

    def building_override(
        self, feature_id, tags, geometry: BaseGeometry | None = None
    ) -> BuildingOverride | None:
        """City override by OSM id, exact name, then containing area."""
        by_id = self.building_by_id or {}
        override = by_id.get(str(feature_id))
        if override is not None:
            return override
        name = tags.get("name")
        if name:
            override = (self.building_by_name or {}).get(str(name))
            if override is not None:
                return override
        if geometry is not None:
            point = geometry.representative_point()
            # Later area features win, so a small, specific polygon can be
            # placed after a broad district one.
            for area, area_override in self.area_overrides or []:
                if area.contains(point):
                    override = area_override
            return override
        return None

    def vehicle_color(self, meta: dict | None) -> str | None:
        """City line/route color, without the leading '#'."""
        if not meta:
            return None
        line = str(meta.get("line") or "").strip()
        route_id = str(meta.get("route_id") or "").strip()
        color = (self.vehicle_by_line or {}).get(line)
        if color is None:
            color = (self.vehicle_by_route or {}).get(route_id)
        return color or None


def _building_override(value: object, where: str) -> BuildingOverride:
    if not isinstance(value, dict):
        raise CityError(f"{where}: expected an object")
    facade = value.get("facade")
    windows = balconies = None
    if facade is not None:
        if not isinstance(facade, dict):
            raise CityError(f"{where}.facade: expected an object")
        windows = _optional_bool(facade.get("windows"), f"{where}.facade.windows")
        balconies = _optional_bool(facade.get("balconies"), f"{where}.facade.balconies")
    roof_shape = value.get("roof_shape")
    if roof_shape is not None and not isinstance(roof_shape, str):
        raise CityError(f"{where}.roof_shape: expected a string")
    return BuildingOverride(
        color=_color(value.get("color"), f"{where}.color"),
        roof_color=_color(value.get("roof_color"), f"{where}.roof_color"),
        roof_shape=roof_shape,
        windows=windows,
        balconies=balconies,
    )


def _read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise CityError(f"{path}: {error}") from error


def _building_maps(document: object) -> tuple[dict, dict]:
    if not isinstance(document, dict):
        raise CityError("buildings.json: expected an object")
    if "by_id" in document or "by_name" in document:
        by_id = document.get("by_id", {})
        by_name = document.get("by_name", {})
    else:
        # Accept a flat id -> override map for the common case.
        by_id = document
        by_name = {}
    if not isinstance(by_id, dict) or not isinstance(by_name, dict):
        raise CityError("buildings.json: by_id/by_name must be objects")
    return (
        {
            str(key): _building_override(value, f"buildings.json.by_id.{key}")
            for key, value in by_id.items()
        },
        {
            str(key): _building_override(value, f"buildings.json.by_name.{key}")
            for key, value in by_name.items()
        },
    )


def _vehicle_maps(document: object) -> tuple[dict[str, str], dict[str, str]]:
    if not isinstance(document, dict):
        raise CityError("vehicles.json: expected an object")
    by_line = document.get("by_line", {})
    by_route = document.get("by_route_id", {})
    if not isinstance(by_line, dict) or not isinstance(by_route, dict):
        raise CityError("vehicles.json: by_line/by_route_id must be objects")
    return (
        {
            str(key): (_color(value, f"vehicles.json.by_line.{key}") or "")[1:]
            for key, value in by_line.items()
        },
        {
            str(key): (_color(value, f"vehicles.json.by_route_id.{key}") or "")[1:]
            for key, value in by_route.items()
        },
    )


def _area_features(
    document: object, path: Path
) -> list[tuple[BaseGeometry, BuildingOverride]]:
    if isinstance(document, dict) and document.get("type") == "FeatureCollection":
        features = document.get("features")
    elif isinstance(document, list):
        features = document
    elif isinstance(document, dict) and document.get("type") == "Feature":
        features = [document]
    else:
        raise CityError(f"{path}: expected a GeoJSON FeatureCollection or array")
    if not isinstance(features, list):
        raise CityError(f"{path}: features must be an array")
    areas: list[tuple[BaseGeometry, BuildingOverride]] = []
    for index, feature in enumerate(features):
        if not isinstance(feature, dict):
            raise CityError(f"{path}.features[{index}]: expected an object")
        geom = feature.get("geometry")
        if not isinstance(geom, dict):
            raise CityError(f"{path}.features[{index}]: missing geometry")
        try:
            area = shape(geom)
        except (TypeError, ValueError, KeyError) as error:
            raise CityError(f"{path}.features[{index}]: {error}") from error
        if area.geom_type not in ("Polygon", "MultiPolygon") or area.is_empty:
            raise CityError(f"{path}.features[{index}]: expected a polygon")
        props = feature.get("properties") or {}
        if not isinstance(props, dict):
            raise CityError(f"{path}.features[{index}].properties: expected an object")
        areas.append(
            (
                area,
                _building_override(props, f"{path}.features[{index}].properties"),
            )
        )
    return areas


def load_city(directory: Path | None) -> CityProfile:
    """Load an optional city directory; a missing/empty directory means Milan defaults."""
    if directory is None:
        return CityProfile()
    if not directory.exists():
        raise CityError(f"city directory does not exist: {directory}")
    city = _read_json(directory / "city.json", {})
    if not isinstance(city, dict):
        raise CityError("city.json: expected an object")
    buildings, building_names = _building_maps(
        _read_json(directory / "buildings.json", {})
    )
    vehicles_by_line, vehicles_by_route = _vehicle_maps(
        _read_json(directory / "vehicles.json", {})
    )
    area_path = directory / "areas.geojson"
    if not area_path.exists():
        area_path = directory / "areas.json"
    areas = _area_features(
        _read_json(area_path, {"type": "FeatureCollection", "features": []}), area_path
    )
    profile = CityProfile(
        name=str(city.get("name") or "Milan"),
        directory=directory,
        building_by_id=buildings,
        building_by_name=building_names,
        vehicle_by_line=vehicles_by_line,
        vehicle_by_route=vehicles_by_route,
        area_overrides=areas,
        asset_base=city.get("asset_base"),
    )
    logger.info(
        "city profile %s: %d building overrides, %d area overrides, %d line colors",
        profile.name,
        len(buildings) + len(building_names),
        len(areas),
        len(vehicles_by_line) + len(vehicles_by_route),
    )
    return profile
