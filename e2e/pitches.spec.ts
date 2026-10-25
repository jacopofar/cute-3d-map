import { test, expect } from "@playwright/test";

import type { MapDebug } from "../src/debug";

// Same trick as the other specs: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key or network access.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

// boot + tile load + the visibility sweeps
test.setTimeout(120_000);

// the sports ground north of Parco Ravizza: tennis, soccer, basketball and
// volleyball pitches inside one window
const COURTS = "#map=17/45.4463/9.1478";

test.beforeEach(async ({ page }) => {
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
});

const count = (page: import("@playwright/test").Page, kind: string) =>
  page.evaluate((wanted) => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    const counts = { total: 0, visible: 0 };
    map.scene.traverse((object) => {
      if (object.userData?.kind !== wanted) return;
      counts.total += 1;
      if (object.visible) counts.visible += 1;
    });
    return counts;
  }, kind);

test("pitches draw their court and paint, and the checkbox hides just those", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/${COURTS}`);
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);

  // both kinds come from the same green feature: the court mesh and the lines
  await expect
    .poll(async () => (await count(page, "pitch")).total, { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await count(page, "pitch_paint")).total, {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  expect((await count(page, "pitch")).visible).toBeGreaterThan(0);
  expect((await count(page, "pitch_paint")).visible).toBeGreaterThan(0);

  // the checkbox lives behind the layers gear
  await page.click("#layer-menu-button");
  await expect(page.locator("#pitches-toggle")).toBeVisible();
  await page.click("#pitches-toggle input");
  expect((await count(page, "pitch")).visible).toBe(0);
  expect((await count(page, "pitch_paint")).visible).toBe(0);
  // the lawn underneath is the parks layer, and it stays
  expect((await count(page, "green")).visible).toBeGreaterThan(0);
  await page.click("#pitches-toggle input");
  expect((await count(page, "pitch")).visible).toBeGreaterThan(0);
  await page.click("#layer-menu-collapse");

  // court paint is a street-level detail: gated on the zoom like the lanes
  await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    map.map.jumpTo({ zoom: 13 });
  });
  await expect
    .poll(async () => (await count(page, "pitch")).visible, { timeout: 15_000 })
    .toBe(0);
  await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    map.map.jumpTo({ zoom: 17 });
  });
  await expect
    .poll(async () => (await count(page, "pitch")).visible, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
