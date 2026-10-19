import { defineConfig } from "@playwright/test";

/*
 * Real-GPU benchmark harness, separate from playwright.config.ts (which runs
 * headless Chromium on SwiftShader, i.e. software rendering).
 *
 * This config drives the installed Google Chrome in headed mode on the machine's
 * display with GPU rasterization forced on, so the frame times are what a user
 * actually sees instead of a pessimistic software-rasterizer floor. Run with
 * `npm run bench:gpu`. It needs a working display session and a GPU; without one
 * Chrome falls back to software and the renderer field in the result says so.
 */
export default defineConfig({
  testDir: "./perf",
  testMatch: "**/interactive.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args: [
        "--use-gl=angle",
        "--use-angle=gl",
        "--ignore-gpu-blocklist",
        "--enable-gpu",
      ],
    },
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
