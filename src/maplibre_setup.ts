// MapLibre GL v6 resolves its web worker at runtime via
//   new URL("./maplibre-gl-worker.mjs", import.meta.url)
// Because that URL is built from a dynamic string, the bundler never sees it
// as a worker and doesn't emit the file — so a production build ships without
// maplibre-gl-worker.mjs and the map fails to load.
//
// The supported fix in v6 is setWorkerUrl(). We hand it a worker that Vite
// bundles itself (?worker&url resolves the worker's own imports and emits a
// hashed asset that works in both `vite dev` and `vite build`).

// see https://maplibre.org/maplibre-gl-js/docs/#installation
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);
