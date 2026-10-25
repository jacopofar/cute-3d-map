import { test, expect } from "@playwright/test";
import type { MapDebug } from "../src/debug";

// Same trick as the smoke tests: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key and no network.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

// a tile's worth of church crosses is cheap, but the tiles have to load first
test.setTimeout(120_000);

const countCrosses = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    const counts = { total: 0, visible: 0 };
    map.scene.traverse((object: any) => {
      if (object.userData?.kind !== "church") return;
      counts.total += 1;
      if (object.visible) counts.visible += 1;
    });
    return counts;
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

test("churches carry crosses, and the checkbox hides them", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // the Duomo: a dozen churches in the tile under it
  await page.goto("/#map=18/45.4641/9.1919");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);
  await expect
    .poll(async () => (await countCrosses(page)).total, { timeout: 30_000 })
    .toBeGreaterThan(0);

  // on by default: one cross mesh per tile that has a church
  expect((await countCrosses(page)).visible).toBeGreaterThan(0);

  // the toggle only hides the ornament; the church walls stay buildings
  await page.click("#layer-menu-button");
  await page.click("#churches-toggle input");
  expect((await countCrosses(page)).visible).toBe(0);
  await page.click("#churches-toggle input");
  expect((await countCrosses(page)).visible).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
