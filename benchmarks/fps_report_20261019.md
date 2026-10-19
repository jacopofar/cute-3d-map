# Per-feature cost, real GPU — 2026-10-19

Hardware/browser: Intel Arc Pro iGPU via ANGLE/Mesa, Google Chrome (new headless)
with GPU rasterization, 1280×800, 90 Hz display, vsync **off** for headroom.
App at central Milan, zoom 18.5, pitch 30; each sample is a 5 s small pan + zoom
inside the already-loaded centre (so the number is the layer's render cost, not
tile loading or facade rebuild). Measured from the custom layer's own render
calls, not rAF. A/B/A bracket per feature (on / off / on).

Baseline: 75.1, 87.4, 78.9 fps (mean), p50 84.7/96.2/89.3 fps. Run-to-run
noise is roughly ±5 fps, so only costs above that are meaningful.

| feature (toggled off) | fps on | fps off | Δ off−on | Δ draw calls | Δ triangles (drawn) | verdict |
|---|---:|---:|---:|---:|---:|---|
| vehicle traffic | 81.8 | 140.5 | **+58.7** | 2 | 164,208 | dominant per-frame cost |
| balconies | 73.1 | 84.5 | **+11.4** | 6 | 357,340 | clear cost |
| bridges & tunnels | 86.7 | 92.0 | +5.3 | 2 | 388 | borderline (bracket spread 10 fps) |
| roof shapes | 77.8 | 81.8 | +4.0 | 4 | 1,224 | small |
| parks & grass | 81.3 | 84.6 | +3.3 | 4 | 1,348 | small |
| clouds | 88.4 | 90.0 | +1.6 | 0 | 0 | noise |
| church crosses | 82.2 | 83.7 | +1.5 | 1 | 288 | noise |
| water | 81.7 | 82.0 | +0.3 | 1 | 34 | noise |
| windows | 86.2 | 85.1 | −1.1 | 6 | 715,984 | negligible despite the triangles |
| parked cars | 81.7 | 79.2 | −2.5 | 1 | 711,384 | negligible; cost is tile/instance build |
| fences | 87.2 | 84.2 | −3.0 | 4 | 1,928 | noise |
| benches | 85.0 | 81.0 | −4.0 | 3 | 21,888 | noise |
| airplanes (tarmac + planes) | 83.8 | 79.1 | −4.7 | 0 | 0 | noise |
| imputed colors | 84.5 | 78.4 | −6.1 | 1 | 10,800 | noise (and it reloads tiles) |
| **night** (vs day) | 89.4 (day) | 83.4 (night) | **−6.0 at night** | 0 | 0 | small, dominated by lighting/basemap |

Negative Δ means turning the feature off was slower: that is noise, not a gain.

## Loaded geometry footprint (deterministic, per 49-tile window)

From the merged feature set (49 loaded tiles, zoom ~17.2):

- facade detail: 18 tiles, ~5.14M vertices (windows + balconies)
- parked cars: 59,282 instances, ~711k triangles, 1 draw call
- benches: 208,008 triangles, 47 meshes
- fences: 26,740 triangles, 49 meshes
- green: 20,440 triangles, 49 meshes
- bridges + tunnels: 23,778 triangles, 69 meshes
- church crosses: 3,480 triangles, 46 meshes
- moving cars/trains: ~164k drawn triangles, 2 draw calls, but a per-frame
  placement update for ~13.6k vehicles

## Reading it

- Only **traffic** is expensive per frame, and it is CPU-side: the renderer
  re-places ~13.6k vehicles every frame. Turning it off nearly doubles the
  headroom (82 → 140 fps on this view).
- **Balconies** are the next visible layer, then roofs/bridges/parks at a few
  fps. Everything else is inside the measurement noise on this GPU.
- Big geometry is not the same as big cost: windows (716k drawn triangles) and
  parked cars (711k) are essentially free to draw here; their cost lands in tile
  payload and per-tile geometry/instance building, which is what the large-pan
  benchmark measures (feature tile payload ~doubled the pan p90; the parking
  blocks `parking` added ~130 MB to the tile set and a pan p99 around 430 ms).
- A visibility checkbox cannot remove the tile/geometry build cost: the mesh is
  still generated when the tile arrives, only the draw is skipped.

Raw numbers: `fps_report_20261019.json` in this folder.
