import { test, expect } from "@playwright/test";

// Same trick as the smoke tests: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key and no network.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

interface Probe {
  map: {
    getCenter(): { lng: number; lat: number };
    getZoom(): number;
    jumpTo(options: { center: [number, number]; zoom: number }): void;
  };
}

const HASH = /#map=([\d.-]+)\/([\d.-]+)\/([\d.-]+)/;

test.beforeEach(async ({ page }) => {
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
});

test("a #map= fragment sets the view and then follows the map", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // the OSM-style permalink: zoom/lat/lon
  await page.goto("/#map=15/45.87425/9.33441");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await page.waitForFunction(() => "__coolMap" in window, null, {
    timeout: 20_000,
  });

  const view = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: Probe }).__coolMap.map;
    const center = map.getCenter();
    return { zoom: map.getZoom(), lat: center.lat, lng: center.lng };
  });
  expect(view.zoom).toBeCloseTo(15, 1);
  expect(view.lat).toBeCloseTo(45.87425, 3);
  expect(view.lng).toBeCloseTo(9.33441, 3);

  // moving the map rewrites the fragment, so the position can be copied
  await page.evaluate(() => {
    (window as unknown as { __coolMap: Probe }).__coolMap.map.jumpTo({
      center: [9.2, 45.5],
      zoom: 17,
    });
  });
  await expect
    .poll(() => Number(HASH.exec(page.url())?.[1] ?? NaN), { timeout: 10_000 })
    .toBeCloseTo(17, 1);
  const match = HASH.exec(page.url())!;
  expect(Number(match[2])).toBeCloseTo(45.5, 2);
  expect(Number(match[3])).toBeCloseTo(9.2, 2);

  expect(errors).toEqual([]);
});
