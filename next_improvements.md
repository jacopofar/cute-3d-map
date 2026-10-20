# Next improvements — 2026-10-20

A working list after the atmosphere pass, the lamp-distance tuning and the
traffic optimization, ordered by visual payoff versus effort. Current context:
`main` has the atmosphere pass (sun shadows, golden hour, night lamps), the
lamp-posts toggle, and the traffic culling + 30 Hz update (`a717e97`, merged as
`2ee8cf2`). The GPU is an Intel Arc (Mesa/ANGLE) and the tile set is ~293 MB.
Traffic no longer dominates the steady state; panning is now the hitch (~156–189
ms p99, 49 tile fetches per 5 s pan). Benchmark:
`benchmarks/fps_report_20261020.md`.

## Quick wins (small branches, obvious results)

- **Walls receiving shadows again, roofs clean.** The last shadow fix was
  ground-only. Split the flat building cap from the walls (or give the cap a
  non-receiving material) so facades can receive neighbour shadows while roofs
  stay flat.
- **Day windows.** They are black dots today. Give them a blue-grey glass tint
  and a procedural frame/sill in the same shader; keep the warm night glow.
- **Car lights at night.** Small emissive head/tail sprites on moving cars, dark
  bodies; parked cars stay dim. Cheap and very effective in motion.
- **Dusk basemap palette.** The golden-hour grade helps, but MapTiler's day
  basemap is still bright. A dusk variant or a slightly stronger grade would tie
  the ground into the scene.

## The next real passes

| Pass | What it adds | Impact | Effort |
|---|---|---|---|
| Glass facades | buildings tagged as glass in OSM become a curtain wall: no windows, balconies or door, a dedicated reflective glass material | High in the CBD, and lighter than facade detail | Medium |
| Facade and roof detail | window frames/sills, ground-floor storefronts with awnings/signs, shutters, chimneys/dormers/antennas, railings | Very high at zoom 17–20 | Medium-high |
| Streetscape | 3D sidewalks/curbs along roads, more street trees with bigger/varied canopies and wind sway, bollards/signs/bus stops | High — grounds buildings, cars and lamps | Medium |
| Night glow | real bloom pass (windows/lamps/signals), SSAO/contact darkening, maybe a subtle vignette | High at night | Medium-high (composition with the MapLibre custom layer needs care) |
| Tile/pan smoothness | incrementally update parked cars/lamps instead of rebuilding on every tile load; quantize/streamline the `parking`/`lamps` payload (tile set ~293 MB) | High for panning | Medium-high |
| Traffic buffer compaction | the instance buffer still carries every slot even when a run is culled; compacting it removes dead instances | Low-medium | Low |
| Water and parks polish | sun glints and shore foam on water, softer mown stripes, paths/flower beds | Medium | Low-medium |
| Cars | low-poly cabin/wheels instead of boxes, still instanced | Medium | Low-medium |

## Glass facades (suggested pass)

The idea: a building whose OSM tags say its facade is glass gets a completely
different look — a curtain wall — instead of windows punched into masonry.

- **Classification.** OSM carries this in the material keys, mainly
  `building:material=glass` / `mirror` and `building:facade:material=glass`.
  `tilegen/main.py:to_building` already reports `building` and `religion`; add a
  `glass` flag the same way and **do not impute it** (an untagged building is
  masonry). This needs a tile regeneration. Keep `building:colour`, which is
  often the glass tint (blue, green, bronze).
- **No facade detail.** Skip these footprints in `facade_layout`/`facade.ts`
  (the way `src/main.ts` builds detail per centre tile), so they get no windows,
  no balconies and no door. That also removes ~a window layer's worth of
  geometry, so the pass should be a small perf win rather than a cost.
- **A dedicated material.** Split glass buildings into their own per-tile mesh
  (kind `glass`, like `roof`/`water`) so they can carry their own
  `ShaderMaterial` and stay one draw call per tile. Suggest an opaque shader
  rather than transparency: a pane grid (procedural, seeded from the building
  position), the building tint, a fresnel term toward a sky/hemisphere color for
  the reflection, and a sharp sun highlight. Transparent sorting across
  thousands of buildings is not worth the look.
- **Night.** Reuse the facade idea of a seeded subset: lit floors in warm amber,
  the rest dark glass, blended with `uNight`.
- **Classification helper.** Mirror `isChurch` in a small `isGlass(properties)`
  (same module or a sibling of `src/elements3d/church.ts`), so the rule is pure
  and unit-testable.
- **Checkbox.** It can stay part of the buildings visibility; if the material
  needs toggling separately it earns its own switch, but that is not needed for
  a first pass.

Milan has plenty of candidates (Porta Nuova, CityLife), so the pass should read
immediately at zoom 17–20, which is where the facade detail lives.

## Suggested order

1. **Wall shadows + day windows** — finish the atmosphere, small and immediate
   improvement to every close-up.
2. **Car lights at night** — highest payoff per line of code, reuses the night
   falloff.
3. **Glass facades** — a new building look, and it deletes geometry instead of
   adding it.
4. **Facade and roof detail** — the biggest "wow" when inspecting the city.
5. **Streetscape** — sidewalks, trees, street furniture.
6. **Night bloom/SSAO** — crown the night look.
7. **Tile/pan smoothness** — now the main interactive cost; keep it in sight
   while adding the above.

## Housekeeping

- The GPU benchmark is refreshed: `benchmarks/fps_report_20261020.{md,json}` on
  `2ee8cf2`, Corso Buenos Aires, three runs. The old per-feature report's
  traffic row is marked as superseded; its other rows stand.
- The full e2e suite has two timeout flakes under the heavy software renderer
  (`airplanes`, `popup`); both pass individually. Consider splitting or raising
  their timeouts before the next big pass.
- Tiles are gitignored; a tilegen change needs the usual regeneration:
  `cd tilegen && uv run main.py ../data/milano_20261016.pbf
  --polygon-filter ../data/milano_polygon.json --output ../public/tiles --no-raw`.
