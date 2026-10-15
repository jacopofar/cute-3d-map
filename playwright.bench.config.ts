import { defineConfig, devices } from "@playwright/test";

// Benchmark harness (see perf/frame_times.spec.ts). Kept separate from
// `npm run test:e2e` because it is slower and its timings are machine specific.
export default defineConfig({
  testDir: "./perf",
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
