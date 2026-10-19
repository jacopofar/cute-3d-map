import { defineConfig } from "vitest/config";

// only the src/ unit tests; the Playwright specs live in e2e/ and perf/ and are
// run by their own configs
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // only the pure modules are unit-tested; the rest of src/ is covered by
      // the Playwright smoke tests and is measured nowhere
      include: [
        "src/daynight.ts",
        "src/traffic_math.ts",
        "src/elements3d/facade_layout.ts",
        "src/elements3d/roof_layout.ts",
        "src/elements3d/bridge_layout.ts",
        "src/elements3d/random.ts",
      ],
      reporter: ["text"],
    },
  },
});
