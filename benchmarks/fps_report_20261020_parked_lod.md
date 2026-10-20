# Parked-car distance LOD, real GPU — 2026-10-20

Hardware/browser: Intel Arc Pro iGPU via ANGLE/Mesa, Google Chrome (headed) with
GPU rasterization, 1280x800, 90 Hz display. App at Corso Buenos Aires, zoom 17.2,
pitch 30 (the committed benchmark view), **at night**, so the bloom pass is
active in every run. Each run: 7 s warm-up, 3.5 s settle, then 5 s pan / tilt /
zoom. Two runs before the change, three after.

Measured on `6568159` (branch `perf/parked-car-lod`). The view is the same as
`fps_report_20261020.md`; that report was daylight and has no bloom, so compare
with this one, not across the two.

## Before / after

| phase | before (fps) | after (fps) | change |
|---|---:|---:|---:|
| pan | 56.2, 59.4 (median 57.8) | 50.0, 51.8, 55.5 (median 51.8) | about −10% mean, **p50 unchanged at 11.1 ms** |
| tilt | 77.8, 66.9 (median 72.4) | 84.4, 82.6, 83.2 (median 83.2) | **+15%** |
| zoom | 75.4, **25.0** (outlier) | 86.4, 86.4, 85.0 (median 86.4) | **+15%** vs 75.4 |

The second "before" zoom run (25 fps) was a machine-load spike: its p50 was
33.4 ms against 11.1 ms everywhere else. The meaningful before zoom is 75.4 fps.

The pan phase is tile/build-bound, so the LOD does not help it; its p50 is
identical and the mean difference comes from a few longer stalls (p99 155 ms
before against 166–178 ms after, long tasks 0.7–0.9 s before against 0.8–1.1 s
after). The fill-bound phases improve consistently.

## What changed

Parked cars within `PARKED_CAR_DETAIL_RADIUS` (600 m) of the view center keep the
52-triangle body (chassis, cabin, wheels); the rest use a 12-triangle box with
the same dimensions and paint. The split is reclassified only when the view
center crosses a 250 m cell, so a pan does not rebuild all nine tiles on every
debounce. Each tile can therefore have a near mesh and a far mesh (14 meshes for
9 tiles at this view, up to 18).

| | before | after |
|---|---:|---:|
| parked cars | 71,370 | 71,370 |
| triangles | 3,711,240 | **1,379,840** |
| meshes | 9 | 14 |

The deterministic win is the triangle count: **−63%** for the parked layer.

## Stats fix

The bloom pass composites a full-screen quad last, so `renderer.info` used to
report the quad (1 draw call, 2 triangles) instead of the scene. `stats()` now
reads the scene's draw calls and triangles captured before the bloom passes, and
also reports the compacted fleet (`vehiclesDrawn`, `trainsDrawn`), the parked-car
mesh count and the parked-car triangle total. At the benchmark view:
`vehiclesDrawn` 287 of 12,988 cars, `trainsDrawn` 3 of 48.

## Reading it

- The LOD pays off where fill matters (tilt, zoom) and costs nothing measurable
  in the p50 of a pan; the pan tail is slightly worse, likely the LOD rebuild at
  a cell crossing.
- The far boxes are only used beyond 600 m, which at the parked-car gate is a
  handful of pixels; a close-up screenshot (`reports/parked-car-lod-corso.png`)
  shows detailed cars along the street and boxes only at the far kerbs.
- Night bloom is included in all these numbers. For the daylight/no-bloom
  baseline use `fps_report_20261020.md`.

Raw numbers: `fps_report_20261020_parked_lod.json` in this folder.
