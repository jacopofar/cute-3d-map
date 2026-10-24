# City profiles

Optional file-driven overrides for the tile generator. The default Milan profile
is intentionally empty and is used automatically; copy this folder for another
city and pass `--city-dir ../cities/<name>` from `tilegen/`.

## `city.json`

```json
{
  "name": "Milano",
  "asset_base": "/city-assets/milano"
}
```

## `buildings.json`

Overrides are keyed by OSM id or exact name. A direct id map is accepted, or the
explicit `by_id` / `by_name` form:

```json
{
  "by_id": {
    "way/123456": {
      "color": "#d8c7a8",
      "roof_color": "#7b4a3a",
      "roof_shape": "gabled",
      "facade": { "windows": false, "balconies": true }
    }
  },
  "by_name": {
    "Duomo": { "color": "#d9c7a6" }
  }
}
```

Supported fields: `color`, `roof_color`, `roof_shape`, `facade.windows`,
`facade.balconies`. City values win over OSM tags and imputed values.

## `areas.geojson`

A GeoJSON `FeatureCollection` (or a bare array of features) whose polygons apply
the same building fields to every building whose representative point falls
inside them. Later features win, so a small landmark polygon can follow a broad
district polygon.

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "name": "Ospedale Niguarda",
        "color": "#f4f4f4",
        "roof_color": "#ffffff"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[9.18, 45.50], [9.19, 45.50], [9.19, 45.51], [9.18, 45.50]]]
      }
    }
  ]
}
```

## `vehicles.json`

```json
{
  "by_line": { "1": "#f2c94c", "90": "#e07a3f" },
  "by_route_id": { "T1": "#f2c94c" }
}
```

A city line color wins over the feed's route color, which wins over the fleet
default.

## Milan profile

- `buildings.json` makes the Duomo beige and Castello Sforzesco brick, with no
  windows or balconies.
- `areas.geojson` repeats those overrides as polygons so the Duomo and castle
  building parts inherit them, and paints the Niguarda hospital buildings white
  from the hospital polygon.
- `vehicles.json` is empty until specific line liveries are added.

## GLTF assets

`assets/` is reserved for a later pass; tilegen does not load GLTF yet.
