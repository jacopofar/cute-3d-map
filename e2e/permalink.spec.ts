import { test, expect } from "@playwright/test";
import type { MapDebug } from "../src/debug";

// Same trick as the smoke tests: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key and no network.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

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
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);

  const view = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap.map;
    const center = map.getCenter();
    return { zoom: map.getZoom(), lat: center.lat, lng: center.lng };
  });
  expect(view.zoom).toBeCloseTo(15, 1);
  expect(view.lat).toBeCloseTo(45.87425, 3);
  expect(view.lng).toBeCloseTo(9.33441, 3);

  // moving the map rewrites the fragment, so the position can be copied
  await page.evaluate(() => {
    (window as unknown as { __coolMap: MapDebug }).__coolMap.map.jumpTo({
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

test("anchors the 3D model at the opened hash center", async ({ page }) => {
  // 45.495/9.190 is within the two-tile origin-reset margin of the hardcoded
  // default (45.497/9.186). The model transform used to be seeded from the
  // default while tileCenter followed the hash, shifting the scene by
  // kilometers until a move triggered an origin reset.
  await page.goto("/#map=15/45.495/9.190");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);

  const probe = await page.evaluate(() => {
    const c = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    return {
      tileCenter: c.tileCenter,
      transform: c.originTransform,
      center: c.map.getCenter(),
    };
  });
  // the constructor's default, if it ever leaks back in
  expect(probe.tileCenter[0]).toBeCloseTo(9.19, 3);
  expect(probe.tileCenter[1]).toBeCloseTo(45.495, 3);
  expect(probe.center.lng).toBeCloseTo(9.19, 3);
  expect(probe.center.lat).toBeCloseTo(45.495, 3);

  // MapLibre's MercatorCoordinate formula; translateX/Y are in those units.
  const mercator = (lng: number, lat: number) => ({
    x: (180 + lng) / 360,
    y:
      (180 -
        (180 / Math.PI) *
          Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) /
      360,
  });
  const expected = mercator(probe.tileCenter[0], probe.tileCenter[1]);
  expect(probe.transform.translateX).toBeCloseTo(expected.x, 7);
  expect(probe.transform.translateY).toBeCloseTo(expected.y, 7);
});
