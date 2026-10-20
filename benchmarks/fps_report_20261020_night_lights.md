# Per-tile night lights, real GPU — 2026-10-20

Hardware/browser: Intel Arc Pro iGPU via ANGLE/Mesa, Google Chrome (headed) with
GPU rasterization, 1280x800, 90 Hz display. App at Corso Buenos Aires, zoom 17.2,
pitch 30, at night (bloom active). Each run: 7 s warm-up, 3.5 s settle, then 5 s
pan / tilt / zoom.

Measured on `0205963` (branch `perf/parked-car-lod`). The before set is the same
branch after the parked-car LOD but before the night-lights change, so the only
difference is the night-light rebuild strategy.

## Before / after

| phase | before (fps) | after (fps) | change |
|---|---:|---:|---:|
| pan | 50.0, 51.8, 55.5 (median 51.8) | 63.9, 61.0 (median 62.5) | **+21%** |
| tilt | 84.4, 82.6, 83.2 (median 83.2) | 85.6, 85.2 (median 85.4) | +3% |
| zoom | 86.4, 86.4, 85.0 (median 86.4) | 88.6, 89.2 (median 88.9) | +3% |

The pan tail improved too: p99 166–178 ms before, 133–144 ms after, and long
tasks went from 0.77–1.08 s to 0.46–0.72 s. That is the point of the change: a
one-tile pan no longer rebuilds every lamp, pool and signal sprite in the 3x3
window.

## What changed

Night lights used to be one union `Points` per layer (`lamplight`, `lamp_pool`,
`signal_light`) plus one `InstancedMesh` per posts layer (`lamppost`,
`signal_post`), rebuilt whenever the centre window or the origin changed. They
are now one mesh per tile and layer, diffed like the parked cars:

- a tile that enters is built; one that leaves is disposed; a tile that stays
  with the same lamp/signal arrays is untouched;
- a projection-origin reset rebuilds all resident tiles (model coordinates are
  relative to the origin);
- the three glow materials are shared by all tiles, so visibility, opacity and
  size are still one update per layer;
- the signal phase recolors each tile's points in place.

At the benchmark view: **9 tiles, 45 night-light meshes** (5 per tile) and
**draw calls 75 → 115**. The 40 extra draws are cheap; the rebuild they replace
was the pan cost.

## Reading it

- The night-light rebuild was a real part of the pan hitch. Removing it gives a
  consistent ~20% improvement in the pan phase with no change in the steady-state
  phases.
- Draw calls went up as expected. If 45 ever matters, one `Points` per layer with
  a per-tile vertex range would keep 5 draws and still update incrementally.
- The lamplight, signal colors, pools, posts and the lampposts checkbox all
  still render; the lampposts e2e now sums the per-tile objects. Screenshot:
  `reports/lights-corso.png`.

## Caveats

- Night only and bloom active; do not compare absolute fps with the daylight
  `fps_report_20261020.md`.
- The benchmark view is Corso Buenos Aires; the Duomo square itself has few
  lamps, so use an avenue view to judge the night look.
- The per-tile Points share a material; changing opacity/size is one update, but
  the material is never disposed (same as the other shared materials).

Raw numbers: `fps_report_20261020_night_lights.json` in this folder.
