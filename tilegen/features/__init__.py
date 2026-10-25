"""Pure OSM-tag predicates and tile feature builders.

Everything here turns one OSM feature (tags + shapely geometry) into a
render-ready tile feature. No parquet or DuckDB I/O: the loaders and the tile
pipeline live in ``main.py``. The builders are grouped by what they produce and
re-exported here, so ``from features import to_building`` keeps working whatever
module a builder ends up in.
"""

# re-exported because the builders take and return them
from city import BuildingOverride as BuildingOverride
from impute import impute as impute

# runways, taxiways, aprons and helipads
from .aeroways import (
    AEROWAY_AREA_KINDS as AEROWAY_AREA_KINDS,
)
from .aeroways import (
    AEROWAY_LINE_KINDS as AEROWAY_LINE_KINDS,
)
from .aeroways import (
    DEFAULT_AEROWAY_WIDTH as DEFAULT_AEROWAY_WIDTH,
)
from .aeroways import (
    to_aeroway as to_aeroway,
)

# construction sites, playgrounds, monuments, transit stops and fountains
from .amenities import (
    is_construction as is_construction,
)
from .amenities import (
    is_monument as is_monument,
)
from .amenities import (
    is_playground as is_playground,
)
from .amenities import (
    monument_kind as monument_kind,
)
from .amenities import (
    to_construction as to_construction,
)
from .amenities import (
    to_fountain as to_fountain,
)
from .amenities import (
    to_monument as to_monument,
)
from .amenities import (
    to_playground as to_playground,
)
from .amenities import (
    to_transit_stop as to_transit_stop,
)
from .amenities import (
    transit_kind as transit_kind,
)

# walls, gates and fences
from .barriers import (
    FENCE_BARRIERS as FENCE_BARRIERS,
)
from .barriers import (
    GATE_BARRIERS as GATE_BARRIERS,
)
from .barriers import (
    MIN_FENCE_LENGTH as MIN_FENCE_LENGTH,
)
from .barriers import (
    WALL_BARRIERS as WALL_BARRIERS,
)
from .barriers import (
    fence_lines as fence_lines,
)
from .barriers import (
    to_fence as to_fence,
)
from .barriers import (
    to_gate as to_gate,
)
from .barriers import (
    to_wall as to_wall,
)

# bridges and tunnel portals
from .bridges import (
    PORTAL_CLASSES as PORTAL_CLASSES,
)
from .bridges import (
    TUNNEL_SKIP as TUNNEL_SKIP,
)
from .bridges import (
    is_bridge as is_bridge,
)
from .bridges import (
    is_tunnel as is_tunnel,
)
from .bridges import (
    portal_angle as portal_angle,
)
from .bridges import (
    to_bridge as to_bridge,
)
from .bridges import (
    to_tunnel as to_tunnel,
)
from .bridges import (
    tunnel_portals as tunnel_portals,
)

# buildings, building parts and glass facades
from .buildings import (
    GLASS_MATERIAL_TAGS as GLASS_MATERIAL_TAGS,
)
from .buildings import (
    building_base as building_base,
)
from .buildings import (
    building_top as building_top,
)
from .buildings import (
    is_glass as is_glass,
)
from .buildings import (
    to_building as to_building,
)
from .buildings import (
    vertical_level as vertical_level,
)
from .common import (
    _LEVEL_RE as _LEVEL_RE,
)
from .common import (
    _METERS_PER_DEGREE as _METERS_PER_DEGREE,
)

# shared parsing and geometry helpers
from .common import (
    COMPASS as COMPASS,
)
from .common import (
    _flatten as _flatten,
)
from .common import (
    area_square_meters as area_square_meters,
)
from .common import (
    line_bearing as line_bearing,
)
from .common import (
    parse_length as parse_length,
)
from .common import (
    parse_level as parse_level,
)
from .common import (
    transport_class as transport_class,
)

# parks, park paths and cemeteries
from .green import (
    GREEN_DENSE_LANDUSE as GREEN_DENSE_LANDUSE,
)
from .green import (
    GREEN_DENSE_LEISURE as GREEN_DENSE_LEISURE,
)
from .green import (
    GREEN_DENSE_NATURAL as GREEN_DENSE_NATURAL,
)
from .green import (
    GREEN_GRASS_LANDUSE as GREEN_GRASS_LANDUSE,
)
from .green import (
    GREEN_GRASS_LEISURE as GREEN_GRASS_LEISURE,
)
from .green import (
    GREEN_GRASS_NATURAL as GREEN_GRASS_NATURAL,
)
from .green import (
    MIN_CEMETERY_AREA as MIN_CEMETERY_AREA,
)
from .green import (
    MIN_GREEN_AREA as MIN_GREEN_AREA,
)
from .green import (
    PARK_PATH_EXCLUDED_FOOTWAY as PARK_PATH_EXCLUDED_FOOTWAY,
)
from .green import (
    PARK_PATH_HIGHWAYS as PARK_PATH_HIGHWAYS,
)
from .green import (
    green_kind as green_kind,
)
from .green import (
    is_cemetery as is_cemetery,
)
from .green import (
    is_green as is_green,
)
from .green import (
    is_park_path as is_park_path,
)
from .green import (
    park_path_kind as park_path_kind,
)
from .green import (
    pitch_sport as pitch_sport,
)
from .green import (
    pitch_surface as pitch_surface,
)
from .green import (
    to_cemetery as to_cemetery,
)
from .green import (
    to_green as to_green,
)
from .green import (
    to_park_path as to_park_path,
)

# power towers and overhead lines
from .power import (
    POWER_LINE_KINDS as POWER_LINE_KINDS,
)
from .power import (
    is_power_line as is_power_line,
)
from .power import (
    power_wire_height as power_wire_height,
)
from .power import (
    to_power_line as to_power_line,
)
from .power import (
    to_power_tower as to_power_tower,
)

# rail and tram ways, and their platforms
from .rail import (
    RAIL_KINDS as RAIL_KINDS,
)
from .rail import (
    is_rail as is_rail,
)
from .rail import (
    is_rail_platform as is_rail_platform,
)
from .rail import (
    to_platform as to_platform,
)
from .rail import (
    to_rail as to_rail,
)

# road data, crossings, signals and painted markings
from .roads import (
    ROAD_PRIORITY as ROAD_PRIORITY,
)
from .roads import (
    ROAD_WIDTHS as ROAD_WIDTHS,
)
from .roads import (
    RoadData as RoadData,
)
from .roads import (
    approach_bearings as approach_bearings,
)
from .roads import (
    crossing_is_marked as crossing_is_marked,
)
from .roads import (
    is_lane_road as is_lane_road,
)
from .roads import (
    parse_lane_count as parse_lane_count,
)
from .roads import (
    road_width as road_width,
)
from .roads import (
    to_crossing as to_crossing,
)
from .roads import (
    to_crosswalk as to_crosswalk,
)
from .roads import (
    to_lane as to_lane,
)
from .roads import (
    to_road_marking as to_road_marking,
)
from .roads import (
    to_stop_point as to_stop_point,
)
from .roads import (
    to_traffic_signal as to_traffic_signal,
)
from .roads import (
    way_bearing as way_bearing,
)

# benches, street furniture and outdoor terraces
from .street import (
    FURNITURE_KINDS as FURNITURE_KINDS,
)
from .street import (
    TERRACE_AMENITIES as TERRACE_AMENITIES,
)
from .street import (
    bench_direction as bench_direction,
)
from .street import (
    furniture_kind as furniture_kind,
)
from .street import (
    is_terrace as is_terrace,
)
from .street import (
    terrace_place as terrace_place,
)
from .street import (
    to_bench as to_bench,
)
from .street import (
    to_furniture as to_furniture,
)
from .street import (
    to_terrace as to_terrace,
)

# trees and tree rows
from .vegetation import (
    CONIFER_GENERA as CONIFER_GENERA,
)
from .vegetation import (
    to_tree as to_tree,
)
from .vegetation import (
    to_tree_row as to_tree_row,
)
from .vegetation import (
    tree_type_size as tree_type_size,
)
from .water import (
    WATER_LANDUSE as WATER_LANDUSE,
)
from .water import (
    WATER_NATURAL as WATER_NATURAL,
)

# water areas and waterways
from .water import (
    WATERWAY_KINDS as WATERWAY_KINDS,
)
from .water import (
    is_water as is_water,
)
from .water import (
    to_water as to_water,
)
from .water import (
    water_kind as water_kind,
)
