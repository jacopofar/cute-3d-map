import { test, expect } from "@playwright/test";
import type { MapDebug } from "../src/debug";

// minimal valid style, same trick as the other specs (no MapTiler key/network)
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

const countMeshes = (page: import("@playwright/test").Page, kind: string) =>
  page.evaluate((wanted) => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    const counts = { total: 0, visible: 0 };
    map.scene.traverse((object: any) => {
      if (object.userData?.kind !== wanted) return;
      counts.total += 1;
      if (object.visible) counts.visible += 1;
    });
    return counts;
  }, kind);

test.beforeEach(async ({ page }) => {
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
});

// parks and grass are their own per-tile mesh: the checkbox is a plain
// visibility switch, so it must hide already-loaded tiles without a reload
test("the parks checkbox hides the green tiles", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Parco Sempione, so there is green in the window
  await page.goto("/#map=16/45.474/9.177");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);
  await expect
    .poll(async () => (await countMeshes(page, "green")).total, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);

  expect((await countMeshes(page, "green")).visible).toBeGreaterThan(0);

  await page.click("#layer-menu-button");
  await page.click("#parks-toggle input");
  expect((await countMeshes(page, "green")).visible).toBe(0);
  await page.click("#parks-toggle input");
  expect((await countMeshes(page, "green")).visible).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
