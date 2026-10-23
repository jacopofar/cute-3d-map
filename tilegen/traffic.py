"""Precompute vehicle trajectories offline.

The frontend no longer simulates traffic: every vehicle is a deterministic
function of wall-clock time. A **loop** is a closed walk of the road graph,
split into per-edge **segs**, each with its own speed (the `maxspeed` tag when
present, else the highway-class default). A loop's `period` is the sum of
seg times, and a **run** carries time keyframes, so a vehicle's position is a
function of the phase `(t + phase * period) % period`.

Loops are built globally, then split per tile at the tile boundaries; a tile
stores the geometry pieces that fall inside it plus the phases/colors of the
vehicles on those loops. A piece's time interval does not depend on the vehicle
phase, so the geometry is shared by every vehicle on the loop.

Two generators exist:

- **faces** (n trains/trams): loops are the planar faces of the whole graph.
- **random** (cars): pick three random nodes and stitch the shortest paths
  A -> B -> C -> A, rejecting loops below the minimum length, until the target
  loop count is reached. Later the node pick can be weighted by census data.

Metric note: everything (loop length, piece length, arc-length offsets) is
measured with the same haversine formula. Shapely's planar lengths are in
degrees and would not line up with the meter/second speeds, so splitting is
done by walking the geometry in arc-length space instead of clipping.
"""

import hashlib
import heapq
import logging
import math
import random
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from itertools import pairwise

from geo import coord_to_tile

# highway values whose ways carry vehicles; the traffic graph is built from
# these ways (read straight from the parquet, not from the tiles)
DRIVABLE_HIGHWAYS = frozenset(
    {
        "motorway",
        "motorway_link",
        "trunk",
        "trunk_link",
        "primary",
        "primary_link",
        "secondary",
        "secondary_link",
        "tertiary",
        "tertiary_link",
        "unclassified",
        "residential",
        "living_street",
        "service",
        "road",
    }
)

# railway values whose ways carry trains/trams. Metros (railway=subway) are
# ignored.
RAILWAYS = frozenset({"rail", "tram"})

# OSM node tags the tiles carry as points: a light or a pedestrian crossing. The
# frontend detects when a vehicle passes one and adds a purely cosmetic speed
# bump (see src/traffic.ts); the generator only stores where they are.
STOP_KINDS = {"traffic_signals": "traffic_signal", "crossing": "crossing"}

# approximate cruise speed (m/s) per drivable highway class, used to derive a
# loop's speed (and therefore its period). Deliberately city-level.
HIGHWAY_SPEEDS = {
    "motorway": 30.0,
    "motorway_link": 20.0,
    "trunk": 25.0,
    "trunk_link": 18.0,
    "primary": 18.0,
    "primary_link": 14.0,
    "secondary": 15.0,
    "secondary_link": 12.0,
    "tertiary": 13.0,
    "tertiary_link": 11.0,
    "unclassified": 11.0,
    "residential": 10.0,
    "living_street": 6.0,
    "service": 8.0,
    "road": 10.0,
}

# cruise speed (m/s) per rail class; trams share the street and are slower
RAIL_SPEEDS = {
    "rail": 20.0,
    "tram": 12.0,
}

# how many meters of loop one vehicle covers; the global vehicle count is
# scaled up (spacing increased) when a network would exceed max_vehicles
DEFAULT_SPACING = 120.0
DEFAULT_MAX_VEHICLES = 40000

CAR_COLORS = ("ff5555", "5555ff", "ffcc33", "33cc99")
GRAY_COLORS = ("e0e0e0", "b0b0b0", "888888", "555555", "333333", "a8a8a8")
GRAY_FRACTION = 0.6
TRAIN_COLORS = ("ff8c00",)

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)


def road_oneway(tags) -> str | None:
    """Normalized oneway direction of a highway way, or None if two-way."""
    value = tags.get("oneway")
    if value in ("yes", "true", "1"):
        return "yes"
    if value in ("-1", "reverse"):
        return "-1"
    if value in ("no", "false", "0"):
        return None
    if tags.get("junction") in ("roundabout", "circular"):
        return "yes"
    return None


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in meters between two (lon, lat) points."""
    r = 6371000.0
    dlat = math.radians(b[1] - a[1])
    dlon = math.radians(b[0] - a[0])
    la1 = math.radians(a[1])
    la2 = math.radians(b[1])
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(la1) * math.cos(la2) * math.sin(dlon / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(h))


def node_key(c: tuple[float, float]) -> str:
    """Node id shared by ways meeting at the same point. Coordinates are
    rounded so shared endpoints collide exactly."""
    return f"{c[0]:.6f},{c[1]:.6f}"


def parse_maxspeed(value) -> float | None:
    """Parse an OSM maxspeed tag to m/s, or None when there is no usable
    number (the caller then falls back to the highway class speed)."""
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in ("walk", "foot"):
        return 1.4
    digits = ""
    for character in text:
        if character.isdigit() or (character == "." and digits and "." not in digits):
            digits += character
        elif digits:
            break
    if not digits:
        if "urban" in text:
            return 50 / 3.6
        if "rural" in text:
            return 90 / 3.6
        return None
    speed = float(digits)
    if "mph" in text:
        return speed * 0.44704
    return speed / 3.6


@dataclass
class Way:
    coords: list[tuple[float, float]]
    oneway: str | None = None
    highway: str | None = None
    maxspeed: float | None = None  # m/s


@dataclass
class Edge:
    key: str
    a: str
    b: str
    coords: list[tuple[float, float]]
    forward: bool
    backward: bool
    highway: str | None
    length: float
    maxspeed: float | None = None  # m/s


@dataclass
class CrossingPoint:
    """An OSM node the tiles carry as a point: a light or a pedestrian crossing.
    Loaded from the parquet by main.py; traffic.py itself does no OSM I/O."""

    lon: float
    lat: float
    kind: str  # "traffic_signal" | "crossing"


@dataclass
class Loop:
    id: str
    segs: list[list[tuple[float, float]]]
    seg_speeds: list[float]  # m/s per seg, parallel to segs
    length: float
    period: float  # seconds for one lap (speeds vary along the loop)
    kind: str = "car"
    vehicles: list[dict] = field(default_factory=list)
    # optional display metadata (GTFS line/route/headsign); the frontend shows
    # it when a moving bus/tram is clicked
    meta: dict | None = None

    @property
    def v(self) -> float:
        """Mean speed, for the report."""
        return self.length / self.period if self.period else 0.0


@dataclass
class TrafficConfig:
    # "faces" (planar faces of the graph) or "random" (three nodes stitched by
    # shortest paths). See the module docstring.
    method: str = "faces"
    loop_count: int = 1000  # random method: how many loops to target
    seed: int = 0  # random method: reproducible node picks
    spacing: float = DEFAULT_SPACING
    max_vehicles: int = DEFAULT_MAX_VEHICLES
    min_loop_length: float = 80.0
    max_loop_length: float = 6000.0
    min_loop_width: float = 6.0
    min_area: float = 1.0
    speeds: dict[str, float] = field(default_factory=lambda: dict(HIGHWAY_SPEEDS))
    default_speed: float = 10.0
    colors: tuple[str, ...] = CAR_COLORS
    gray_colors: tuple[str, ...] = GRAY_COLORS
    gray_fraction: float = GRAY_FRACTION


# cars: 1000 loops stitched through three random nodes. Random points are far
# apart, so loops are long (Milan: ~20 km) and a spacing-derived fleet would be
# huge, so max_vehicles is the real density knob here (it scales the spacing up
# to fit). min length only drops short loops; there is a generous max because
# long loops are the point.
CAR_CONFIG = TrafficConfig(
    method="random",
    loop_count=1000,
    seed=20261016,
    spacing=18.0,
    max_vehicles=15000,
    min_loop_length=400.0,
    max_loop_length=30000.0,
)

# trains/trams: sparse and long, no grays, one orange
TRAIN_CONFIG = TrafficConfig(
    spacing=800.0,
    max_vehicles=2000,
    min_loop_length=500.0,
    max_loop_length=20000.0,
    speeds=dict(RAIL_SPEEDS),
    default_speed=15.0,
    colors=TRAIN_COLORS,
    gray_colors=(),
    gray_fraction=0.0,
)


class Graph:
    """Road graph whose nodes are the rounded endpoints of ways."""

    def __init__(self) -> None:
        self.edges: dict[str, Edge] = {}
        self.incident: dict[str, list[str]] = defaultdict(list)
        self.coords: dict[str, tuple[float, float]] = {}

    def add_way(self, way: Way, min_length: float = 1.0) -> None:
        coords = way.coords
        if len(coords) < 2:
            return
        a = node_key(coords[0])
        b = node_key(coords[-1])
        if a == b:
            return
        key = f"{a}|{b}" if a < b else f"{b}|{a}"
        if key in self.edges:
            return
        length = sum(haversine_m(p, q) for p, q in pairwise(coords))
        if length < min_length:
            return
        self.edges[key] = Edge(
            key=key,
            a=a,
            b=b,
            coords=list(coords),
            forward=way.oneway != "-1",
            backward=way.oneway != "yes",
            highway=way.highway,
            length=length,
            maxspeed=way.maxspeed,
        )
        self.incident[a].append(key)
        self.incident[b].append(key)
        self.coords[a] = coords[0]
        self.coords[b] = coords[-1]


def edge_speed(edge: Edge, config: TrafficConfig) -> float:
    """Travel speed along an edge: its maxspeed tag when present, else the
    highway-class default. Clamped to a sane range."""
    speed = (
        edge.maxspeed
        if edge.maxspeed is not None
        else config.speeds.get(edge.highway, config.default_speed)
    )
    return max(1.0, min(40.0, speed))


def seg_length(seg: list[tuple[float, float]]) -> float:
    return sum(haversine_m(a, b) for a, b in pairwise(seg))


def loop_period(segs: list[list[tuple[float, float]]], speeds: list[float]) -> float:
    """Seconds for one lap: each seg crossed at its own speed."""
    return sum(seg_length(seg) / speed for seg, speed in zip(segs, speeds) if speed > 0)


def build_graph(ways, min_length: float = 1.0) -> Graph:
    graph = Graph()
    for way in ways:
        graph.add_way(way, min_length)
    return graph


def _other(edge: Edge, node: str) -> str:
    return edge.b if edge.a == node else edge.a


def _angular_order(graph: Graph) -> dict[str, list[str]]:
    """Incident edges of every node, sorted by bearing, so the planar face
    walk can pick the next edge at a node."""
    order: dict[str, list[str]] = {}
    for node, keys in graph.incident.items():
        here = graph.coords[node]
        coslat = math.cos(math.radians(here[1]))
        items: list[tuple[float, str]] = []
        for key in keys:
            other = graph.coords[_other(graph.edges[key], node)]
            angle = math.atan2(other[1] - here[1], (other[0] - here[0]) * coslat)
            items.append((angle, key))
        items.sort()
        order[node] = [key for _, key in items]
    return order


def _faces(graph: Graph) -> list[list[tuple[str, str]]]:
    """Every directed half-edge (node, edge) belongs to exactly one face; walk
    them with the standard rule "the next edge is the one before the twin in
    counter-clockwise order" (equivalently the twin rotated one step
    clockwise). The result is the list of face walks; the one unbounded face of
    each connected component winds the other way and is dropped later by the
    area sign."""
    order = _angular_order(graph)
    index = {n: {k: i for i, k in enumerate(keys)} for n, keys in order.items()}
    visited: set[tuple[str, str]] = set()
    faces: list[list[tuple[str, str]]] = []
    for node, keys in graph.incident.items():
        for key in keys:
            if (node, key) in visited:
                continue
            walk: list[tuple[str, str]] = []
            cn, ce = node, key
            while (cn, ce) not in visited:
                visited.add((cn, ce))
                walk.append((cn, ce))
                edge = graph.edges[ce]
                v = _other(edge, cn)
                ring = order[v]
                ce = ring[(index[v][ce] - 1) % len(ring)]
                cn = v
            faces.append(walk)
    return faces


def _signed_area_m(coords: list[tuple[float, float]]) -> float:
    if len(coords) < 3:
        return 0.0
    lat0 = sum(c[1] for c in coords) / len(coords)
    coslat = math.cos(math.radians(lat0))
    area = 0.0
    for (lon1, lat1), (lon2, lat2) in pairwise(coords + [coords[0]]):
        area += (lon1 * coslat) * lat2 - (lon2 * coslat) * lat1
    return area / 2 * (111320.0**2)


def _steps_legal(graph: Graph, steps: list[tuple[str, int]]) -> bool:
    for key, direction in steps:
        edge = graph.edges[key]
        if direction == 1:
            if not edge.forward:
                return False
        elif not edge.backward:
            return False
    return True


def _walk_to_steps(
    graph: Graph, nodes: list[str], keys: list[str]
) -> tuple[list[tuple[str, int]], list[list[tuple[float, float]]]]:
    """Turn a node/key cycle into directed steps and per-edge oriented
    geometry."""
    steps: list[tuple[str, int]] = []
    segs: list[list[tuple[float, float]]] = []
    for i, key in enumerate(keys):
        edge = graph.edges[key]
        direction = 1 if edge.a == nodes[i] else -1
        steps.append((key, direction))
        segs.append(edge.coords if direction == 1 else list(reversed(edge.coords)))
    return steps, segs


def _face_to_loop(graph: Graph, walk: list[tuple[str, str]], config: TrafficConfig):
    nodes = [n for n, _ in walk]
    keys = [k for _, k in walk]
    # a bridge is walked out and back; drop any face that repeats an edge
    if len(set(keys)) != len(keys):
        return None
    coords = [graph.coords[n] for n in nodes]
    area = _signed_area_m(coords)
    if area <= config.min_area:
        return None
    length = sum(graph.edges[k].length for k in keys)
    if not (config.min_loop_length <= length <= config.max_loop_length):
        return None
    # dual carriageways leave long, thin "median" faces; the width is
    # 2 * area / perimeter for a strip, so this rejects them without needing
    # to know which OSM way a sliver came from
    if 2 * area / length < config.min_loop_width:
        return None

    forward = _walk_to_steps(graph, nodes, keys)
    if _steps_legal(graph, forward[0]):
        steps, segs = forward
    else:
        # the walk is the planar (CCW) direction; driving it may require the
        # opposite direction
        reverse_nodes = [nodes[0], *reversed(nodes[1:])]
        reverse = _walk_to_steps(graph, reverse_nodes, list(reversed(keys)))
        if not _steps_legal(graph, reverse[0]):
            return None
        steps, segs = reverse

    speeds = [edge_speed(graph.edges[key], config) for key, _ in steps]
    loop_id = hashlib.sha1("|".join(sorted(set(keys))).encode()).hexdigest()[:12]
    return Loop(
        id=loop_id,
        segs=segs,
        seg_speeds=speeds,
        length=length,
        period=loop_period(segs, speeds),
    )


def find_loops(graph: Graph, config: TrafficConfig, kind: str = "car") -> list[Loop]:
    loops: list[Loop] = []
    for walk in _faces(graph):
        loop = _face_to_loop(graph, walk, config)
        if loop is not None:
            loop.kind = kind
            loops.append(loop)
            if len(loops) % 100 == 0:
                logger.info(f"Found {len(loops)} so far")
    loops.sort(key=lambda loop: loop.id)
    return loops


def _directed_adjacency(
    graph: Graph,
) -> dict[str, list[tuple[str, str, float]]]:
    """node -> (neighbor, edge key, length) for every legal travel direction."""
    adjacency: dict[str, list[tuple[str, str, float]]] = defaultdict(list)
    for key, edge in graph.edges.items():
        if edge.forward:
            adjacency[edge.a].append((edge.b, key, edge.length))
        if edge.backward:
            adjacency[edge.b].append((edge.a, key, edge.length))
    return adjacency


def _a_star(
    graph: Graph,
    adjacency: dict[str, list[tuple[str, str, float]]],
    start: str,
    goal: str,
) -> list[tuple[str, int]] | None:
    """Shortest directed path start -> goal as (edge key, direction) steps.

    A* with the great-circle distance to the goal: edge lengths are geodesic,
    so the heuristic never overestimates and the search stays small even on the
    whole Milan graph."""
    if start == goal:
        return []
    goal_coord = graph.coords[goal]
    dist: dict[str, float] = {start: 0.0}
    prev: dict[str, tuple[str, str]] = {}
    heap: list[tuple[float, float, str]] = [
        (haversine_m(graph.coords[start], goal_coord), 0.0, start)
    ]
    while heap:
        _, travelled, node = heapq.heappop(heap)
        if node == goal:
            steps: list[tuple[str, int]] = []
            while node != start:
                previous, key = prev[node]
                edge = graph.edges[key]
                steps.append((key, 1 if edge.a == previous else -1))
                node = previous
            steps.reverse()
            return steps
        if travelled > dist.get(node, math.inf):
            continue
        for neighbor, key, weight in adjacency[node]:
            candidate = travelled + weight
            if candidate < dist.get(neighbor, math.inf):
                dist[neighbor] = candidate
                prev[neighbor] = (node, key)
                estimate = candidate + haversine_m(graph.coords[neighbor], goal_coord)
                heapq.heappush(heap, (estimate, candidate, neighbor))
    return None


def _steps_to_segs(
    graph: Graph, steps: list[tuple[str, int]]
) -> list[list[tuple[float, float]]]:
    segs: list[list[tuple[float, float]]] = []
    for key, direction in steps:
        edge = graph.edges[key]
        segs.append(edge.coords if direction == 1 else list(reversed(edge.coords)))
    return segs


def random_loops(graph: Graph, config: TrafficConfig, kind: str = "car") -> list[Loop]:
    """Loop A -> B -> C -> A through three random nodes, via shortest paths.

    Repeats until `config.loop_count` loops (or a bounded number of attempts),
    keeping a loop only when its length is within the configured bounds. The
    pick is seeded, so a run is reproducible."""
    adjacency = _directed_adjacency(graph)
    nodes = [node for node, edges in graph.incident.items() if edges]
    if len(nodes) < 3:
        return []
    rng = random.Random(config.seed)
    loops: list[Loop] = []
    seen: set[str] = set()
    max_attempts = config.loop_count * 50
    attempts = 0
    while len(loops) < config.loop_count and attempts < max_attempts:
        attempts += 1
        a, b, c = rng.sample(nodes, 3)
        first = _a_star(graph, adjacency, a, b)
        if first is None:
            continue
        second = _a_star(graph, adjacency, b, c)
        if second is None:
            continue
        third = _a_star(graph, adjacency, c, a)
        if third is None:
            continue
        steps = first + second + third
        length = sum(graph.edges[key].length for key, _ in steps)
        if not (config.min_loop_length <= length <= config.max_loop_length):
            continue
        loop_id = hashlib.sha1(
            "|".join(f"{key}:{direction}" for key, direction in steps).encode()
        ).hexdigest()[:12]
        if loop_id in seen:
            continue
        seen.add(loop_id)
        segs = _steps_to_segs(graph, steps)
        speeds = [edge_speed(graph.edges[key], config) for key, _ in steps]
        loops.append(
            Loop(
                id=loop_id,
                segs=segs,
                seg_speeds=speeds,
                length=length,
                period=loop_period(segs, speeds),
                kind=kind,
            )
        )
    return loops


def build_loops(graph: Graph, config: TrafficConfig, kind: str = "car") -> list[Loop]:
    """Dispatch to the configured loop generator."""
    if config.method == "random":
        return random_loops(graph, config, kind)
    return find_loops(graph, config, kind=kind)


def _vehicle_color(seed: str, config: TrafficConfig) -> str:
    h = int(hashlib.md5(seed.encode()).hexdigest(), 16)
    gray = h % 1000 < config.gray_fraction * 1000
    palette = config.gray_colors if gray else config.colors
    return palette[(h // 1000) % len(palette)]


def assign_vehicles(loops: list[Loop], config: TrafficConfig) -> None:
    """Spread vehicles evenly along every loop (phase k/n) and give each a
    stable color. The global vehicle budget raises the spacing when the
    network would otherwise exceed max_vehicles."""
    spacing = config.spacing

    def count(sp: float) -> int:
        return sum(max(1, round(loop.length / sp)) for loop in loops)

    estimate = count(spacing)
    if estimate > config.max_vehicles and estimate > 0:
        spacing *= estimate / config.max_vehicles

    for loop in loops:
        n = max(1, round(loop.length / spacing))
        loop.vehicles = [
            {
                "phase": k / n,
                "color": _vehicle_color(f"{loop.id}:{k}", config),
            }
            for k in range(n)
        ]


_LERP_EPS = 1e-12


def _tile_y_to_lat(y: float, zoom: int) -> float:
    n = 2**zoom
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))


def _lat_to_tile_y(lat: float, zoom: int) -> int:
    n = 2**zoom
    return int(
        (
            1
            - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat)))
            / math.pi
        )
        / 2
        * n
    )


def _lerp(
    p: tuple[float, float], q: tuple[float, float], t: float
) -> tuple[float, float]:
    return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)


def segment_pieces(
    p: tuple[float, float], q: tuple[float, float], zoom: int
) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    """Split a straight lon/lat segment at every tile boundary it crosses, so
    each returned piece lies inside a single tile."""
    n = 2**zoom
    ts = [0.0, 1.0]
    if p[0] != q[0]:
        x0 = int((p[0] + 180) / 360 * n)
        x1 = int((q[0] + 180) / 360 * n)
        for x in range(min(x0, x1), max(x0, x1) + 1):
            t = (x / n * 360 - 180 - p[0]) / (q[0] - p[0])
            if 0.0 < t < 1.0:
                ts.append(t)
    if p[1] != q[1]:
        y0 = _lat_to_tile_y(p[1], zoom)
        y1 = _lat_to_tile_y(q[1], zoom)
        for y in range(min(y0, y1), max(y0, y1) + 1):
            t = (_tile_y_to_lat(y, zoom) - p[1]) / (q[1] - p[1])
            if 0.0 < t < 1.0:
                ts.append(t)
    ts.sort()
    return [
        (_lerp(p, q, a), _lerp(p, q, b)) for a, b in pairwise(ts) if b - a > _LERP_EPS
    ]


def _tile_of_mid(
    a: tuple[float, float], b: tuple[float, float], zoom: int
) -> tuple[int, int]:
    return coord_to_tile((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, zoom)


def split_runs(
    loop: Loop, zoom: int
) -> list[
    tuple[
        tuple[int, int],
        float,
        float,
        list[tuple[float, float]],
        list[float],
    ]
]:
    """Split a loop into runs of constant tile, in time space.

    Returns (tile, t0, t1, coords, times): t0/t1 are seconds into the loop's
    period, and times[i] is the seconds from the run's start to coords[i]
    (times[0] is 0). Speed is constant along an edge, so a run split inside one
    stays linear in time; the client samples by time. The first run starts at
    t0 = 0 and the last ends at t1 = period, so the seam at t = 0/period is two
    runs, resolved by the client's half-open interval."""
    runs: list[
        tuple[
            tuple[int, int],
            float,
            float,
            list[tuple[float, float]],
            list[float],
        ]
    ] = []
    current: dict | None = None
    elapsed = 0.0
    for seg, speed in zip(loop.segs, loop.seg_speeds):
        seg_time = seg_length(seg) / speed if speed > 0 else 0.0
        pieces: list[tuple[tuple[float, float], tuple[float, float]]] = []
        for a, b in pairwise(seg):
            pieces.extend(segment_pieces(a, b, zoom))
        subtotal = sum(haversine_m(a, b) for a, b in pieces) or 1.0
        acc = 0.0
        for a, b in pieces:
            ta = elapsed + seg_time * acc / subtotal
            acc += haversine_m(a, b)
            tb = elapsed + seg_time * acc / subtotal
            tile = _tile_of_mid(a, b, zoom)
            if (
                current is not None
                and current["tile"] == tile
                and current["coords"][-1] == a
            ):
                current["coords"].append(b)
                current["times"].append(tb - current["start_t"])
            else:
                if current is not None and len(current["coords"]) >= 2:
                    runs.append(
                        (
                            current["tile"],
                            current["start_t"],
                            current["start_t"] + current["times"][-1],
                            current["coords"],
                            current["times"],
                        )
                    )
                current = {
                    "tile": tile,
                    "start_t": ta,
                    "coords": [a, b],
                    "times": [0.0, tb - ta],
                }
        elapsed += seg_time
    if current is not None and len(current["coords"]) >= 2:
        runs.append(
            (
                current["tile"],
                current["start_t"],
                current["start_t"] + current["times"][-1],
                current["coords"],
                current["times"],
            )
        )
    return runs


def loops_to_tiles(loops: list[Loop], zoom: int) -> dict[tuple[int, int], list[dict]]:
    """Group every loop's runs by tile. Each tile entry carries the loop
    identity, speed and period (so the client can merge the pieces of one loop
    across the tiles that hold them) and the phases/colors of its vehicles."""
    by_tile: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for loop in loops:
        per_tile: dict[tuple[int, int], list[dict]] = defaultdict(list)
        for tile, t0, t1, coords, times in split_runs(loop, zoom):
            per_tile[tile].append(
                {
                    "t0": round(t0, 3),
                    "t1": round(t1, 3),
                    "coords": [[round(c[0], 7), round(c[1], 7)] for c in coords],
                    "times": [round(t, 3) for t in times],
                }
            )
        for tile, runs in per_tile.items():
            by_tile[tile].append(
                {
                    "kind": loop.kind,
                    "id": loop.id,
                    "v": round(loop.v, 3),
                    "period": round(loop.period, 3),
                    "runs": runs,
                    "vehicles": [
                        {"phase": round(v["phase"], 6), "color": v["color"]}
                        for v in loop.vehicles
                    ],
                    **({"meta": loop.meta} if loop.meta else {}),
                }
            )
    return by_tile


def build_fleets(
    ways_by_kind: dict[str, list[Way]],
    configs: dict[str, TrafficConfig] | None = None,
) -> dict[str, list[Loop]]:
    """Build one fleet of loops per kind ("car", "train").

    Kept separate from the tile serialization so the loops themselves are
    available for the report and the troubleshooting GeoJSON."""
    if configs is None:
        configs = {"car": CAR_CONFIG, "train": TRAIN_CONFIG}
    fleets: dict[str, list[Loop]] = {}
    for kind, ways in ways_by_kind.items():
        config = configs[kind]
        graph = build_graph(ways)
        logger.info(f"built graph for {kind=}")
        loops = build_loops(graph, config, kind)
        assign_vehicles(loops, config)
        fleets[kind] = loops
    return fleets


def loops_to_records(loops: list[Loop]) -> list[dict]:
    """The loops as JSON-safe records, for the on-disk cache. Coordinates stay
    as (lon, lat) pairs; `loops_from_records` rebuilds the tuples, so a cached
    fleet is byte-for-byte the one `build_fleets` would have produced."""
    return [
        {
            "id": loop.id,
            "kind": loop.kind,
            "length": loop.length,
            "period": loop.period,
            "seg_speeds": list(loop.seg_speeds),
            "segs": [[list(coord) for coord in seg] for seg in loop.segs],
            "vehicles": [dict(vehicle) for vehicle in loop.vehicles],
            "meta": loop.meta,
        }
        for loop in loops
    ]


def loops_from_records(records: list[dict]) -> list[Loop]:
    return [
        Loop(
            id=record["id"],
            kind=record["kind"],
            length=record["length"],
            period=record["period"],
            seg_speeds=list(record["seg_speeds"]),
            segs=[[(coord[0], coord[1]) for coord in seg] for seg in record["segs"]],
            vehicles=[
                {"phase": vehicle["phase"], "color": vehicle["color"]}
                for vehicle in record["vehicles"]
            ],
            meta=record.get("meta"),
        )
        for record in records
    ]


def fleets_to_records(fleets: dict[str, list[Loop]]) -> dict[str, list[dict]]:
    return {kind: loops_to_records(loops) for kind, loops in fleets.items()}


def fleets_from_records(records: dict[str, list[dict]]) -> dict[str, list[Loop]]:
    return {kind: loops_from_records(loops) for kind, loops in records.items()}


def fleets_cache_key(
    ways_by_kind: dict[str, list[Way]],
    configs: dict[str, TrafficConfig],
) -> str:
    """Content hash of everything that feeds the loop builders: the ways and the
    per-kind config. A changed parquet (different ways) or a retuned config
    changes the key, so the cache never serves loops for other inputs."""
    digest = hashlib.sha1()
    for kind in sorted(ways_by_kind):
        digest.update(kind.encode())
        for way in ways_by_kind[kind]:
            digest.update(repr(way).encode())
        digest.update(repr(asdict(configs[kind])).encode())
    return digest.hexdigest()[:16]


def fleets_to_tiles(
    fleets: dict[str, list[Loop]], zoom: int
) -> dict[tuple[int, int], list[dict]]:
    """Merge every fleet's per-tile route entries into one traffic block."""
    by_tile: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for loops in fleets.values():
        for tile, entries in loops_to_tiles(loops, zoom).items():
            by_tile[tile].extend(entries)
    return by_tile


def build_traffic_tiles(
    ways_by_kind: dict[str, list[Way]],
    zoom: int,
    configs: dict[str, TrafficConfig] | None = None,
) -> dict[tuple[int, int], list[dict]]:
    """Convenience entry point: ways -> per-tile serialized traffic."""
    return fleets_to_tiles(build_fleets(ways_by_kind, configs), zoom)


def loop_coords(loop: Loop) -> list[tuple[float, float]]:
    """The whole loop as one closed polyline (dedup the shared endpoints)."""
    coords: list[tuple[float, float]] = []
    for seg in loop.segs:
        if coords and coords[-1] == seg[0]:
            coords.extend(seg[1:])
        else:
            coords.extend(seg)
    return coords


# loop-length buckets (meters) for the report histogram; they span the short
# face loops up to the long random ones
HISTOGRAM_BUCKETS = (
    0.0,
    500.0,
    1000.0,
    2000.0,
    5000.0,
    10000.0,
    15000.0,
    20000.0,
    25000.0,
    30000.0,
    math.inf,
)


def _bucket_label(low: float, high: float) -> str:
    return f"{low:.0f}+" if high == math.inf else f"{low:.0f}-{high:.0f}"


def loop_report(
    fleets: dict[str, list[Loop]],
    crossing_points: list[CrossingPoint] | None = None,
) -> str:
    """A markdown description of each fleet's loop sizes (count, min/mean/max,
    histogram). Pure text, so it is easy to test and to diff between runs. When
    the signal/crossing points are given, their counts are appended."""
    lines = ["# Vehicle loop report", ""]
    for kind in sorted(fleets):
        loops = fleets[kind]
        lines.append(f"## {kind}")
        lines.append("")
        if not loops:
            lines.extend(["No loops.", ""])
            continue
        lengths = sorted(loop.length for loop in loops)
        count = len(lengths)
        vehicles = sum(len(loop.vehicles) for loop in loops)
        total = sum(lengths)
        periods = sum(loop.period for loop in loops)
        mean_speed = total / periods if periods else 0.0
        lines.extend(
            [
                f"- Loops: **{count}**",
                f"- Vehicles: **{vehicles}**",
                (
                    f"- Length (m): min **{lengths[0]:.0f}**, mean "
                    f"**{total / count:.0f}**, max **{lengths[-1]:.0f}**"
                ),
                f"- Total loop length: {total / 1000:.1f} km",
                (
                    f"- Fleet mean speed: {mean_speed:.1f} m/s "
                    f"({mean_speed * 3.6:.0f} km/h)"
                ),
                "",
                "| length bucket (m) | loops | vehicles |",
                "| --- | --- | --- |",
            ]
        )
        for low, high in pairwise(HISTOGRAM_BUCKETS):
            bucket = [loop for loop in loops if low <= loop.length < high]
            lines.append(
                f"| {_bucket_label(low, high)} | {len(bucket)} | "
                f"{sum(len(loop.vehicles) for loop in bucket)} |"
            )
        lines.append("")
    if crossing_points is not None:
        counts = Counter(point.kind for point in crossing_points)
        lines.extend(
            [
                "## signals and crossings",
                "",
                f"- Traffic signals: **{counts.get('traffic_signal', 0)}**",
                f"- Crossings: **{counts.get('crossing', 0)}**",
                "",
                (
                    "These are stored as points in the tiles; the frontend "
                    "slows vehicles down as they pass them."
                ),
                "",
            ]
        )
    return "\n".join(lines)


def loops_to_geojson(
    loops: list[Loop],
    crossing_points: list[CrossingPoint] | None = None,
) -> list[dict]:
    """The loops as LineString features, for visual troubleshooting. When the
    signal/crossing points are given they are appended as Point features."""
    features: list[dict] = [
        {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": [
                    [round(lon, 7), round(lat, 7)] for lon, lat in loop_coords(loop)
                ],
            },
            "properties": {
                "id": loop.id,
                "kind": loop.kind,
                "length_m": round(loop.length, 1),
                "speed_mps": round(loop.v, 2),
                "period_s": round(loop.period, 1),
                "vehicles": len(loop.vehicles),
            },
        }
        for loop in loops
    ]
    for point in crossing_points or []:
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(point.lon, 7), round(point.lat, 7)],
                },
                "properties": {"kind": point.kind},
            }
        )
    return features
