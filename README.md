# threejs_map — a MapLibre + Three.js 3D city

An OSM-derived 3D diorama for the browser rendered with Three.js and MapLibre.

This project was designed specifically for the city of Milan,Italy, but can be
easily adapted to any other place.
It features extruded buildings with real roofs, trees, animated water, street
furniture, precomputed traffic, and a day/night cycle driven by the real sun.

Everything is clickable, and you can follow a bus or **drive around** yourself.

![A map with buildings rendered in red](example.png)

It is also possible to immediately export buildings as GLTF and insert your
custom GLTF data in the map.

## Quick start

You need Node (with npm) and [uv](https://docs.astral.sh/uv/) for the tile
generator.

**1. Generate the tiles.** No tiles ship with the repo (`public/tiles` is
gitignored: a city is hundreds of megabytes), so the app needs them built once.
Put an OSM PBF extract in `data/` (e.g. from
[Geofabrik](https://download.geofabrik.de)) and run:

```bash
cd tilegen
uv run main.py ../data/milano_20261016.pbf \
  --polygon-filter ../data/milano_polygon.json \
  --output ../public/tiles --no-raw
```

**2. Run the frontend.**

```bash
npm install

# the basemap comes from MapTiler: you need a (free) API key
echo "VITE_MAPTILER_KEY=your_key" > .env

npm run dev
```

The app fetches tiles from `tiles/{x}/{y}.json` relative to the app origin;
without step 1 it opens on an empty basemap. Optionally add
`PERF_ENDPOINT=https://example.com/t/perf` to `.env` to post frame timings —
leave it out and reporting is a no-op.

## Using it

- **Inspect anything** — click a building, a tree, a lake, a bridge, a bus; the
  popup shows the name, the kind and a link to OSM. A building's popup exports
  it as a `.glb`.
- **Layers menu** — the gear at the top left toggles the individual layers
  (windows, roofs, water, lamp posts, transit, parked cars, ...) and the basemap.
- **Follow and drive** — click a moving vehicle to follow it, or hit **Drive** in
  the layers menu and take the wheel (WASD, Escape to leave).
- **Share a view** — the URL carries `#map=zoom/lat/lon`, so a position can be
  copied and pasted.

## Project layout

| path | what |
| --- | --- |
| `src/` | the Vite/TypeScript app: the `CoolMap` wrapper, the tile loader and one module per rendered layer under `src/elements3d/` |
| `tilegen/` | the offline Python generator (uv, ruff, ty, pytest) that turns an OSM extract into `public/tiles/*.json` |
| `cities/` | optional per-city overrides (colors, models, fleet lengths) |
| `e2e/`, `perf/` | the Playwright specs and the frame-time benchmarks |
| `docs/` | the technical documentation |

## Commands

```bash
npm run dev               # dev server (needs VITE_MAPTILER_KEY in .env)
npm run build             # type check plus production build
npm run preview           # serve the production build

npm run test:check        # format, both type checks, unit tests (the per-change loop)
npm run test:unit         # vitest with coverage
npm run test:e2e:changed  # the Playwright specs a diff against main touches
npm run test:e2e          # the full Playwright suite (the merge gate)
npm run test:e2e:smoke    # boot and permalink only
npm run bench             # frame-time benchmark (headless)
npm run bench:gpu         # the same, headed on the real GPU
```

`npx playwright install` once for the e2e browser. Playwright needs generated
tiles to boot against.

## Docs

- [docs/architecture.md](docs/architecture.md) — the two halves, the tile
  contract (every `cmtype`), the frontend, projection and the projection origin,
  imputed tags, known limitations.
- [docs/layers.md](docs/layers.md) — what every rendered layer looks like and
  which module draws it: buildings and parts, churches, water, cemeteries,
  furniture, fountains, transit, terraces, playgrounds, monuments, construction,
  crosswalks, road paint, platforms and rails, sidewalks, walls and gates,
  rooftop gear, park paths, power lines, pitches, bridges and tunnels.
- [docs/traffic.md](docs/traffic.md) — the precomputed routes, parked cars, drive
  mode and the loop report.
- [docs/tilegen.md](docs/tilegen.md) — the generation flags, city profiles, the
  tile inspector, GTFS inspection and the Python tooling.
- [docs/performance.md](docs/performance.md) — what costs frames and how to
  measure it.
- [AGENTS.md](AGENTS.md) — the module-by-module map and the domain lexicon.

## License

The code is [MIT licensed](LICENSE). What it renders is not part of it: the map
data comes from OpenStreetMap (© OpenStreetMap contributors, ODbL) and the
basemap from MapTiler, each under its own terms.
