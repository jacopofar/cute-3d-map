import { defineConfig } from "vitest/config";

// only the src/ unit tests; the Playwright specs live in e2e/ and perf/ and are
// run by their own configs
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // The modules with a unit test next to them. The rest of src/ (main.ts,
      // selection.ts, the fleets, the render loop) needs a browser and is
      // covered by the Playwright specs, so measuring it here would report a
      // number nobody can move. Keep this list in step with the test files:
      // a module tested but missing here is invisible, and a module listed
      // without a test drags the total down for no reason.
      include: [
        "src/airplanes.ts",
        "src/collision.ts",
        "src/daynight.ts",
        "src/driving.ts",
        "src/feature_pick.ts",
        "src/geojson_data.ts",
        "src/parked_cars.ts",
        "src/parking_layout.ts",
        "src/projection.ts",
        "src/traffic_math.ts",
        "src/vehicle_body.ts",
        "src/elements3d/bench.ts",
        "src/elements3d/bridge_layout.ts",
        "src/elements3d/building.ts",
        "src/elements3d/cemetery.ts",
        "src/elements3d/church.ts",
        "src/elements3d/construction.ts",
        "src/elements3d/crosswalk.ts",
        "src/elements3d/facade.ts",
        "src/elements3d/facade_layout.ts",
        "src/elements3d/fence.ts",
        "src/elements3d/fountain.ts",
        "src/elements3d/furniture.ts",
        "src/elements3d/glass.ts",
        "src/elements3d/green.ts",
        "src/elements3d/lane_layout.ts",
        "src/elements3d/monument.ts",
        "src/elements3d/park_path.ts",
        "src/elements3d/pitch.ts",
        "src/elements3d/pitch_layout.ts",
        "src/elements3d/platform.ts",
        "src/elements3d/playground.ts",
        "src/elements3d/power.ts",
        "src/elements3d/rail.ts",
        "src/elements3d/random.ts",
        "src/elements3d/road_marking.ts",
        "src/elements3d/roof.ts",
        "src/elements3d/roof_layout.ts",
        "src/elements3d/rooftop.ts",
        "src/elements3d/sidewalk.ts",
        "src/elements3d/terrace.ts",
        "src/elements3d/tombstone_rows.ts",
        "src/elements3d/transit.ts",
        "src/elements3d/tree.ts",
        "src/elements3d/wall.ts",
        "src/elements3d/water.ts",
      ],
      // A ratchet, not a goal: a change that drops coverage by more than a
      // point has to either add a test or come with a deliberate re-tune. The
      // numbers are a little under the current total so unrelated churn does
      // not fail the loop.
      thresholds: {
        statements: 85,
        branches: 67,
        functions: 83,
        lines: 87,
      },
      reporter: ["text"],
    },
  },
});
