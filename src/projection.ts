// Geographic projection helpers, shared by the tile loader, the geometry
// builders and the pure pickers. Kept in their own module so `elements3d/` and
// `feature_pick` do not have to import `geojson_data` (which owns fetching and
// THREE) just to convert a lon/lat: that import cycle made the pure modules
// drag the whole renderer in with them.

// static, the zoom at which 3D tile data are stored; must match TILE_ZOOM in
// tilegen/README.md and tilegen/geo.py
export const TILE_ZOOM = 15;

// WGS84 degrees to EPSG:3857 meters. A first-order approximation is fine here:
// the model is a small local patch and every consumer applies the same formula,
// so a constant bias cancels out.
export function epsg4326toEpsg3857(
  coordinates: [number, number],
): [number, number] {
  let x = (coordinates[0] * 20037508.34) / 180;
  let y =
    Math.log(Math.tan(((90 + coordinates[1]) * Math.PI) / 360)) /
    (Math.PI / 180);
  y = (y * 20037508.34) / 180;
  return [x, y];
}

// Model coordinates are meters relative to the projection origin, squeezed by
// cos(latitude) so a degree of longitude is not stretched wider than a degree
// of latitude on screen.
export function toModelCoords(
  coord: [number, number],
  originMeters: [number, number],
  scaleFactor: number,
): [number, number] {
  const coordMeters = epsg4326toEpsg3857(coord);
  return [
    (coordMeters[0] - originMeters[0]) * scaleFactor,
    (coordMeters[1] - originMeters[1]) * scaleFactor,
  ];
}

// The cos(latitude) term above, spelled once so call sites stop repeating the
// `Math.cos((2 * Math.PI * lat) / 360)` incantation.
export function scaleFactorAt(latitude: number): number {
  return Math.cos((2 * Math.PI * latitude) / 360);
}
