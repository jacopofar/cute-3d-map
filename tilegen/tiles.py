"""The tile contract: what one feature and one tile document look like.

The frontend reads these JSON files with hand-written casts, so the shapes are
spelled out twice; this is the tilegen side, and it is the one the builders are
checked against. ``TileFeature`` is the wrapper every builder returns, and the
per-``cmtype`` classes below document the properties that go inside it.

Two rules that shape these classes:

* a builder drops the keys whose value is ``None``, so almost everything is
  optional — a building with no name has no ``name`` key at all;
* ``cmtype`` is the one key that is always there, since it is what the frontend
  switches on.
"""

from typing import Any, Literal, Required, TypedDict


class TileFeature(TypedDict):
    """One GeoJSON feature exactly as a builder returns it."""

    type: Literal["feature"]
    id: str
    geometry: dict[str, Any]
    properties: dict[str, Any]


# --- properties, one class per cmtype ---------------------------------------


class BuildingProperties(TypedDict, total=False):
    """``building`` covers plain footprints and ``building:part`` volumes."""

    cmtype: Required[Literal["building"]]
    building: str
    # the top elevation; `base` is where a part starts (0 on the street)
    height: float
    base: float
    color: str
    roof_shape: str
    roof_color: str
    # which of the three fields above tilegen sampled rather than read
    imputed: list[str]
    name: str
    street: str
    housenumber: str
    religion: str
    glass: bool
    solar: bool
    facade: str
    model: dict[str, Any]


class TreeProperties(TypedDict, total=False):
    cmtype: Required[Literal["tree", "tree_row"]]
    type: str
    size: float


class WaterProperties(TypedDict, total=False):
    cmtype: Required[Literal["water"]]
    water: str
    layer: int
    name: str


class GreenProperties(TypedDict, total=False):
    cmtype: Required[Literal["green"]]
    green: str
    # a sports pitch: the `sport` tag, passed through for the frontend's paint
    sport: str
    # the mapped `surface`, so the court can be tinted by what it is made of
    surface: str
    name: str


class ParkPathProperties(TypedDict, total=False):
    cmtype: Required[Literal["park_path"]]
    kind: str
    surface: str
    width: float
    name: str


class CemeteryProperties(TypedDict, total=False):
    cmtype: Required[Literal["cemetery"]]
    name: str


class ConstructionProperties(TypedDict, total=False):
    cmtype: Required[Literal["construction"]]
    construction: str
    crane: bool
    site_area: float
    name: str


class CrosswalkProperties(TypedDict, total=False):
    cmtype: Required[Literal["crosswalk"]]
    crossing: str
    markings: str
    bearing: float
    width: float


class RoadMarkingProperties(TypedDict, total=False):
    cmtype: Required[Literal["road_marking"]]
    kind: str
    directions: list[float]
    width: float
    lanes: int
    oneway: bool
    turn_lanes: list[str]
    turn_lanes_backward: list[str]


class LaneProperties(TypedDict, total=False):
    """A drivable way, for the lane paint the frontend draws itself."""

    cmtype: Required[Literal["lane"]]
    width: float
    lanes: int
    oneway: bool
    highway: str


class StopPointProperties(TypedDict):
    """The data-only signal and crossing points."""

    cmtype: Required[Literal["traffic_signal", "crossing"]]


# `class` is a keyword, so these two use the functional form to keep the key
# spelled the way the tile does
BridgeProperties = TypedDict(
    "BridgeProperties",
    {
        "cmtype": Required[Literal["bridge"]],
        "bridge": str,
        "class": str,
        "layer": int,
        "name": str,
    },
    total=False,
)

TunnelProperties = TypedDict(
    "TunnelProperties",
    {
        "cmtype": Required[Literal["tunnel"]],
        "class": str,
        "layer": int,
        "angle": float,
        "name": str,
    },
    total=False,
)


class RailProperties(TypedDict, total=False):
    cmtype: Required[Literal["rail"]]
    kind: str
    name: str
    ref: str


class PlatformProperties(TypedDict, total=False):
    cmtype: Required[Literal["platform"]]
    kind: str
    name: str
    ref: str


class BenchProperties(TypedDict, total=False):
    cmtype: Required[Literal["bench"]]
    direction: float
    # both spellings: OSM's `colour` is the usual key, `color` shows up too
    colour: str
    color: str


class FurnitureProperties(TypedDict, total=False):
    cmtype: Required[Literal["furniture"]]
    furniture: str
    angle: float


class TerraceProperties(TypedDict, total=False):
    cmtype: Required[Literal["terrace"]]
    terrace: str
    name: str


class PlaygroundProperties(TypedDict, total=False):
    cmtype: Required[Literal["playground"]]
    size: float
    name: str


class MonumentProperties(TypedDict, total=False):
    cmtype: Required[Literal["monument"]]
    kind: str
    memorial: str
    name: str


class TransitStopProperties(TypedDict, total=False):
    cmtype: Required[Literal["transit_stop"]]
    stop: str
    shelter: bool
    name: str


class FountainProperties(TypedDict, total=False):
    cmtype: Required[Literal["fountain"]]
    size: float
    name: str


class WallProperties(TypedDict, total=False):
    cmtype: Required[Literal["wall"]]
    wall: str
    height: float
    name: str


class FenceProperties(TypedDict, total=False):
    cmtype: Required[Literal["fence"]]
    barrier: str
    name: str


class GateProperties(TypedDict, total=False):
    cmtype: Required[Literal["gate"]]
    bearing: float
    width: float


class PowerTowerProperties(TypedDict, total=False):
    cmtype: Required[Literal["power_tower"]]
    height: float
    voltage: str
    name: str
    operator: str
    ref: str


class PowerLineProperties(TypedDict, total=False):
    cmtype: Required[Literal["power_line"]]
    height: float
    voltage: str
    cables: str
    wires: str
    name: str
    operator: str
    ref: str


class AerowayProperties(TypedDict, total=False):
    cmtype: Required[Literal["aeroway"]]
    aeroway: str
    width: float


# the ones the pipeline emits rather than a builder
class RooftopProperties(TypedDict, total=False):
    cmtype: Required[Literal["rooftop"]]
    kind: str
    base: float
    height: float
    size: float
    name: str


class SidewalkProperties(TypedDict):
    cmtype: Required[Literal["sidewalk"]]


Properties = (
    BuildingProperties
    | TreeProperties
    | WaterProperties
    | GreenProperties
    | ParkPathProperties
    | CemeteryProperties
    | ConstructionProperties
    | CrosswalkProperties
    | RoadMarkingProperties
    | StopPointProperties
    | BridgeProperties
    | TunnelProperties
    | RailProperties
    | PlatformProperties
    | BenchProperties
    | FurnitureProperties
    | TerraceProperties
    | PlaygroundProperties
    | MonumentProperties
    | TransitStopProperties
    | FountainProperties
    | WallProperties
    | FenceProperties
    | GateProperties
    | PowerTowerProperties
    | PowerLineProperties
    | AerowayProperties
    | RooftopProperties
    | SidewalkProperties
)

# cmtype -> the class that documents its properties, for the schema test.
# TypedDicts are values, not types, so there is no precise class type to give
# this dict; the test reads `__required_keys__` / `__optional_keys__` off it.
BY_CMTYPE: dict[str, Any] = {
    "building": BuildingProperties,
    "tree": TreeProperties,
    "tree_row": TreeProperties,
    "water": WaterProperties,
    "green": GreenProperties,
    "park_path": ParkPathProperties,
    "cemetery": CemeteryProperties,
    "construction": ConstructionProperties,
    "crosswalk": CrosswalkProperties,
    "lane": LaneProperties,
    "road_marking": RoadMarkingProperties,
    "traffic_signal": StopPointProperties,
    "crossing": StopPointProperties,
    "bridge": BridgeProperties,
    "tunnel": TunnelProperties,
    "rail": RailProperties,
    "platform": PlatformProperties,
    "bench": BenchProperties,
    "furniture": FurnitureProperties,
    "terrace": TerraceProperties,
    "playground": PlaygroundProperties,
    "monument": MonumentProperties,
    "transit_stop": TransitStopProperties,
    "fountain": FountainProperties,
    "wall": WallProperties,
    "fence": FenceProperties,
    "gate": GateProperties,
    "power_tower": PowerTowerProperties,
    "power_line": PowerLineProperties,
    "aeroway": AerowayProperties,
    "rooftop": RooftopProperties,
    "sidewalk": SidewalkProperties,
}


class TileDocument(TypedDict):
    """One ``public/tiles/{x}/{y}.json`` file."""

    type: Literal["FeatureCollection"]
    features: list[TileFeature]
    # precomputed vehicle routes, parked-car rows and street lamps; typed by
    # their own modules (traffic.py, parking.py, lamps.py)
    traffic: list[dict[str, Any]]
    parking: list[dict[str, Any]]
    lamps: list[list[float]]
