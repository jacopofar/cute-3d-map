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

test("the locate button centers the map on the browser position", async ({
  page,
  context,
}) => {
  // a location far from the default Milan view, so the move is unambiguous
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 48.8566, longitude: 2.3522 });
  await page.goto("/");
  await expect(page.locator(".maplibregl-ctrl-geolocate")).toBeVisible();
  await page.click(".maplibregl-ctrl-geolocate");
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const map = (window as unknown as { __coolMap: any }).__coolMap;
          const center = map.map.getCenter();
          return Math.hypot(center.lat - 48.8566, center.lng - 2.3522);
        }),
      { timeout: 15_000 },
    )
    .toBeLessThan(0.01);
});
