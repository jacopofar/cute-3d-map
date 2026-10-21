# Merged features, real GPU — 2026-10-21

Hardware/browser: Intel Arc Pro iGPU via ANGLE/Mesa, Google Chrome (headed) with
GPU rasterization, 1280x800, 90 Hz display. App at Corso Buenos Aires, zoom 17.2,
pitch 30, daytime (bloom off). Two runs of the committed benchmark: 7 s warm-up,
3.5 s settle, then 5 s pan / tilt / zoom.

Measured on `b7ee4a4` (after the eight-pass batch, cemeteries, street furniture,
fountains and transit stops).

| run | phase | fps | p50 ms | p90 ms | p99 ms | long tasks |
|---|---|---:|---:|---:|---:|---:|
| 1 | pan | 59.2 | 11.1 | 11.2 | 211.1 | 883 ms |
| 2 | pan | 55.4 | 11.1 | 11.2 | 166.7 | 865 ms |
| 1 | tilt | 89.0 | 11.1 | 11.2 | 11.2 | 52 ms |
| 2 | tilt | 89.4 | 11.1 | 11.2 | 11.2 | 0 ms |
| 1 | zoom | 89.8 | 11.1 | 11.2 | 11.2 | 0 ms |
| 2 | zoom | 89.8 | 11.1 | 11.2 | 11.2 | 0 ms |

Loaded window: 49 tiles, 613 meshes, 3.22M triangles, 104 draw calls.

## Reading it

- Steady-state tilt and zoom are at the 90 Hz cap: the new small layers do not
  cost fill rate.
- Panning is still the hitch: p99 167–211 ms and ~0.9 s of long tasks per 5 s
  phase, with 49 tile fetches. That is the per-tile parse/merge/build path, not
  traffic or drawing. The tile payload/pan smoothness item remains the main
  performance target.
- Draw calls went from 57 (2026-10-20, before the batch) to 104; the extra calls
  are the small per-tile layers (furniture, fountains, transit, night lights) and
  are not the steady-state bottleneck.
- The 2026-10-20 report was a different time of day and machine load; compare
  this one with itself, not across reports.

Raw numbers: `fps_report_20261021.json`.
