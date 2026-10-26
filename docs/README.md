# Docs

The [README](../README.md) has the screenshot and the quick start; these pages
hold the technical detail, one topic each.

| page | what it covers |
| --- | --- |
| [architecture.md](architecture.md) | the two halves of the project, the tile contract (`cmtype` by `cmtype`), the frontend modules, projection and origin, imputed tags, known limitations |
| [layers.md](layers.md) | what each rendered layer looks like and where its code lives: buildings, water, churches, furniture, transit, rails, bridges, night lights, ... |
| [traffic.md](traffic.md) | the precomputed routes, parked cars, drive mode and the loop report |
| [tilegen.md](tilegen.md) | generating tiles, city profiles, the tile inspector, GTFS inspection, the lint/test tooling |
| [performance.md](performance.md) | what costs frames, and how to measure it without lying to yourself |

[AGENTS.md](../AGENTS.md) at the repo root is the module-by-module map plus the
domain lexicon, kept current for agents; it is the place to look when you need
to know which file owns something.
