import { test, expect } from "@playwright/test";

// A minimal valid Mapbox/MapLibre style with no sources or layers, so the map
// reaches "style.load" without any MapTiler key or network access.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

test.beforeEach(async ({ page }) => {
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
});

test("boots and mounts the map without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  expect(errors).toEqual([]);
});

test("loads 3D tiles for the initial view", async ({ page }) => {
  const statuses: number[] = [];
  page.on("response", (response) => {
    const { pathname } = new URL(response.url());
    if (/^\/tiles\/\d+\/\d+\.json$/.test(pathname)) {
      statuses.push(response.status());
    }
  });
  await page.goto("/");
  await expect
    .poll(() => statuses.length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  // a tile is either present (200) or legitimately absent (404 -> empty)
  for (const status of statuses) {
    expect([200, 404]).toContain(status);
  }
});

test("boots in precomputed traffic mode (default)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  expect(errors).toEqual([]);
});
