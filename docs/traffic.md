# Traffic and driving

## Precomputed traffic

Every vehicle is precomputed offline in `tilegen/traffic.py`; `src/traffic.ts`
is a stateless renderer that samples it. There is no runtime simulation.

- A **loop** is a closed walk of the road (or rail) graph. Cars build them
  randomly: three nodes A, B, C are picked and the shortest directed paths
  A -> B -> C -> A are stitched into a loop (`method="random"`, 1000 loops,
  min 400 m, seeded so a run is reproducible). Trains/trams use the planar
  faces of the rail graph instead (`method="faces"`, min 500 m).
- Speed varies along a loop: each edge travels at its `maxspeed` tag when
  present, otherwise the highway-class default (`primary`/`residential`/...),
  so the loop's `period` is the sum of edge times. Runs carry `(coords, times)`
  keyframes and the vehicle is placed by phase, so it speeds up and slows down
  as it moves between road classes. Vehicles are spread evenly in time by
  `phase`.
- Each loop is split per tile at tile boundaries. A tile stores the pieces
  that fall inside it (`runs`, with `t0`/`t1` seconds into `period`) plus the
  `vehicles` (`phase` + color) on those loops; each entry is tagged `kind`
  (`car`, `train`, `bus` or `tram`) and the renderer merges pieces that share a
  loop `id`. Nothing simulates, nothing rebuilds when a tile arrives, and a
  piece is drawn only while its half-open `[t0, t1)` contains the phase.
- Two fleets come out of the same machinery by default: cars on drivable
  highways (up to 15k vehicles across the 1000 loops) and trains/trams on
  `railway=rail`/`tram` (spacing 800 m, orange).
- With `--gtfs gtfs.zip`, the feed supplies the bus and tram paths instead:
  each `shapes.txt` shape is a one-way loop in its GTFS direction, route type
  3/11 is a bus and type 0 a tram, and only `railway=rail` remains in the OSM
  train fleet. `stop_times.txt` supplies segment travel times and a short dwell
  at each stop; there is no synthetic return trip, so a vehicle pops at the end
  of a shape and reappears at its start. The feed's route short name, long name
  and trip headsign travel with the loop; clicking a moving bus/tram opens a
  popup with its line and direction and starts following it. The feed is
  optional and ignored without `--traffic`.
- A vehicle whose loop time falls in one of the loop's **hidden windows** is not
  drawn at all and cannot be picked: the window is a stretch where the route
  runs under something (a tunnel, a covered section, `layer < 0`), and there is
  no ground geometry to hide it behind, so it would otherwise drive over the
  park above it. It pops out at the far portal.
- Vehicles slow down at **signals and crossings**, cosmetically only. The tiles
  carry the OSM `highway=traffic_signals` / `highway=crossing` nodes as points;
  the renderer matches them to each loop's vertices, turns the windows into
  loop-time with the local speed, and adds a smooth speed bump. A global light —
  axis 0 (roughly E-W) green while axis 1 (N-S) is red, swapping every 8 s —
  decides which: on a red axis the vehicle eases down from 60 m out to ~15% of
  cruise, is back at cruise by the crossing, and eases back over ~255 m; on
  green it nudges up to 1.15x and settles. The bump is smooth and returns to
  zero, so the lap (path and timing) is unchanged: nothing waits, nothing is
  simulated.
- Vehicles are gated on the zoom (and the traffic checkbox) as before. The
  renderer updates a slice of the fleet per frame at ~30 Hz and culls runs
  outside the map bounds, so only the vehicles in view are sampled and placed.

## Parked cars

The kerbs are filled too, statically. `tilegen/parking.py` authors parking as
one line per side of every parking-eligible road (no motorways/trunks, no
`*_link` connectors, no roundabouts, nothing under 30 m), at a pitch set by a
seeded style — parallel, perpendicular or fishbone. Rows that share a kerb (a
service way beside a road, the two carriageways of a dual carriageway) are
deduped before they reach the tile. A row end within 8 m of another car road is
trimmed back by 8 m, so cars do not park in the mouth of a junction; pedestrian
areas are intentionally not part of this check.

The tile carries only the authored rows, clipped at tile seams: `coords`, style,
pitch, side and occupancy. `src/parking_layout.ts` walks each row and places 95%
of the bays in model space; `src/parked_cars.ts` draws the result with the moving
cars' body as one static `InstancedMesh`. Parked cars are lit like the buildings,
so they darken at night, unlike the unlit moving fleet. Like the window detail
the layer only exists above zoom 17 and only for the 3x3 tiles around the
center: the fully loaded 7x7 window would be ~370k cars, almost all off-screen.
The **parked cars** checkbox is a plain visibility switch.

## Drive mode

The **Drive** button in the layers menu drops a red car onto the nearest
precomputed car route and hands it to WASD (the arrow keys work too): W/S
accelerate, brake and reverse, A/D steer, and Escape leaves. The camera chases
it at a fixed zoom and pitch, looking a little ahead of the car, so the map's
own pan/zoom gestures are disabled while driving. A HUD shows the speed and the
keys.

The car is a small arcade model (`src/driving.ts`), not a simulation: speed and
heading are integrated in substeps, and `src/collision.ts` tests the car's
rectangle against building footprints and fence/wall lines from the loaded
tiles. A blocked step slides along the free axis, and an already-overlapping car
is allowed to drive out. A hidden fence or wall layer does not block. Entering
and leaving the mode send `drive-start` / `drive-stop` events to the perf
endpoint, when one is configured.

On a coarse pointer drive mode also shows `#drive-touch`, two thumb clusters for
steering and pedals; their input merges with the keys and is cleared on exit or
blur.

## Loop report

Because loop length is the main tuning knob, the generator writes a report
(`tilegen/report/`, or `--report-dir`):

- `loops.md` — per fleet, the loop count, vehicle count, min/mean/max length and
  a length histogram, plus a `signals and crossings` section with their counts.
- `loops.geojson` — every loop as a `LineString` (no vehicles), plus a `Point`
  per signal/crossing, for looking at them on a map. By default it keeps only
  loops intersecting `data/milano_polygon.json`; pass `--report-polygon` to clip
  to another area, or `--no-report` to skip the report entirely.

`tilegen/report/` is gitignored (it is generated from local data).
