import { test, expect } from "@playwright/test";

import type { MapDebug } from "../src/debug";

// Same trick as the other specs: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key or network access.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

// boot + tile load + two visibility sweeps
test.setTimeout(120_000);

// Corso Buenos Aires at street zoom: a wide avenue with lanes on both sides
const AVENUE = "#map=17.5/45.478/9.209";

test.beforeEach(async ({ page }) => {
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
});

const countLanes = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    const counts = { total: 0, visible: 0 };
    map.scene.traverse((object) => {
      if (object.userData?.kind !== "lane") return;
      counts.total += 1;
      if (object.visible) counts.visible += 1;
    });
    return counts;
  });

test("lane paint appears at street zoom and follows the checkbox", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/${AVENUE}`);
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);

  await expect
    .poll(async () => (await countLanes(page)).total, { timeout: 45_000 })
    .toBeGreaterThan(0);
  expect((await countLanes(page)).visible).toBeGreaterThan(0);

  // the checkbox lives behind the layers gear
  await page.click("#layer-menu-button");
  await expect(page.locator("#lanes-toggle")).toBeVisible();
  await page.click("#lanes-toggle input");
  expect((await countLanes(page)).visible).toBe(0);
  await page.click("#lanes-toggle input");
  expect((await countLanes(page)).visible).toBeGreaterThan(0);
  await page.click("#layer-menu-collapse");

  // paint is a street-level detail: it is gated on the zoom like the sidewalks
  await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    map.map.jumpTo({ zoom: 13 });
  });
  await expect
    .poll(async () => (await countLanes(page)).visible, { timeout: 15_000 })
    .toBe(0);
  await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    map.map.jumpTo({ zoom: 17.5 });
  });
  await expect
    .poll(async () => (await countLanes(page)).visible, { timeout: 20_000 })
    .toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
