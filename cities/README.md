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

## `vehicles.json`

```json
{
  "by_line": { "1": "#f2c94c", "90": "#e07a3f" },
  "by_route_id": { "T1": "#f2c94c" }
}
```

A city line color wins over the feed's route color, which wins over the fleet
default.

## GLTF assets

`assets/` is reserved for a later pass; tilegen does not load GLTF yet.
