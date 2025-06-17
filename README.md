# Demo: Maplibre + Three.js + GeoJSON

__NOTE__: this is currently not working, coordinates are skewed.

This repository implements the rendering of a polygon as a 3D element in a map,
using Maplibre for the map, Three.js for the 3D graphic and reading the definition
from a GeoJSON object.

It is based on the [MapLibre example](https://maplibre.org/maplibre-gl-js/docs/examples/add-3d-model/)
but adapted to Typescript and with a model generated from the GeoJSON
coordinates (epsg:4326) instead of a GLTF.

![A map with a building rendered in red](example.png)
