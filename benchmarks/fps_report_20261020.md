# Interactive frame times, real GPU — 2026-10-20

Hardware/browser: Intel Arc Pro iGPU via ANGLE/Mesa, Google Chrome (headed) with
GPU rasterization, 1280x800, 90 Hz display. App at Corso Buenos Aires (a busy
avenue, not the pedestrian Duomo), zoom 17.2, pitch 30 — the committed benchmark
view in `perf/interactive.spec.ts`, so the phases see moving traffic as well as
the static layers. Each run: 7 s warm-up (tiles, merged meshes, shader compile,
facade detail), 3.5 s settle, then 5 s pan / tilt / zoom. Pan crosses the z15
tile grid; zoom crosses the facade-detail threshold.

Measured on `2ee8cf2` (traffic culling + 30 Hz slices, merged). Three runs of the
same code, to show the spread this shared box actually produces:

| run (UTC) | phase | fps | p50 | p90 | p99 | worst | long tasks | tile fetches |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 13:19 | pan | 35.9 | 16.7 | 37.9 | 188.9 | 246.7 | 1047 ms | 49 |
| 14:21 | pan | 55.2 | 11.1 | 11.2 | 155.7 | 200.1 | 939 ms | 49 |
| 14:23 | pan | 49.8 | 11.2 | 20.8 | 166.8 | 235.7 | 779 ms | 49 |
| 13:19 | tilt | 70.8 | 11.1 | 22.2 | 33.4 | 66.6 | 69 ms | 0 |
| 14:21 | tilt | 73.9 | 11.2 | 16.7 | 17.8 | 33.4 | 0 ms | 0 |
| 14:23 | tilt | 71.2 | 12.2 | 19.7 | 24.8 | 50.9 | 3922 ms | 0 |
| 13:19 | zoom | 71.0 | 11.1 | 22.2 | 33.3 | 55.5 | 0 ms | 0 |
| 14:21 | zoom | 85.9 | 11.1 | 13.4 | 22.2 | 31.0 | 0 ms | 0 |
| 14:23 | zoom | 68.5 | 15.7 | 18.4 | 24.0 | 24.4 | 0 ms | 0 |

Medians: **pan 49.8 fps**, **tilt 71.2 fps**, **zoom 71.0 fps**. The steady-state
phases sit at 11–16 ms frames, i.e. near the 90 Hz display cap; the pan spread
(36–55 fps) is the shared-box drift the README warns about, not a code change —
all three runs are the same commit. Read differences below ~15% as noise.

## Loaded geometry footprint (deterministic, per 49-tile window)

- 49 tiles, 445 meshes, 3.06M triangles, 57 draw calls
- 25,488 buildings; 5.76M facade vertices over 18 centre tiles
- 12,988 moving vehicles (plus 48 trains, 2 draw calls with the fleet)
- 71,370 parked cars, 1 draw call
- per-tile merged geometry, largest first: trees 1.37M triangles, buildings
  811k, benches 224k, roofs 39k, fences 27k, green 22k, tunnels 19k,
  bridges 13k, water 3.4k, church crosses 3.5k

## Reading it

- **Traffic is no longer the dominant per-frame cost.** The per-feature
  ablation in `fps_report_20261019.md` measured vehicle traffic at 58.7 fps of
  headroom; that was before `a717e97`. The culling and 30 Hz slices move the
  cost off the steady-state phases, and the tilt/zoom numbers above are within
  display-cap noise of each other. The old report's other rows are still the
  best per-feature numbers available.
- **Panning is still where the hitches are**: 156–189 ms p99 and 0.8–1 s of long
  tasks, with 49 tile fetches per phase. That is the per-tile parse/merge and
  detail/instancing rebuild, not fill rate — the same cost the 20261019 report
  attributed to the tile payload (`parking`/`lamps` ~130 MB). This is the next
  thing to attack if the goal is smooth panning.
- **Draw calls are tiny** (57 for the whole loaded scene), so the static layers
  are not a rendering problem; their cost lands in tile payload and build time.
- **Visibility checkboxes do not remove build cost.** The mesh/instances are
  still created when the tile arrives; only the draw is skipped.

Raw numbers (all three runs): `fps_report_20261020.json` in this folder.
