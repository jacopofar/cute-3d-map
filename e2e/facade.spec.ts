import { test, expect } from "@playwright/test";
import type { MapDebug } from "../src/debug";

// Same trick as the smoke tests: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key and no network.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

// __coolMap is exposed by src/main.ts for the benchmark
const probe = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __coolMap?: MapDebug };
    return w.__coolMap
      ? { ready: true as const, stats: w.__coolMap.stats() }
      : { ready: false as const };
  });

test.beforeEach(async ({ page }) => {
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
});

test("builds facade detail only once zoomed in", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();

  // wait for the app and its tiles, then check the initial (zoomed-out) state
  await expect
    .poll(async () => (await probe(page)).ready, {
      timeout: 15_000,
    })
    .toBe(true);
  const initial = await probe(page);
  expect(initial.ready && initial.stats.facadeTiles).toBe(0);

  // zoom in past the gate and let the debounced move pass build the detail
  await page.evaluate(() => {
    const w = window as unknown as { __coolMap: MapDebug };
    w.__coolMap.map.jumpTo({ zoom: 17 });
  });
  await expect
    .poll(
      async () => {
        const state = await probe(page);
        return state.ready ? state.stats.facadeTiles : 0;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  const zoomed = await probe(page);
  expect(zoomed.ready && zoomed.stats.facadeVertices).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
