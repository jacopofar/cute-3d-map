import { test, expect } from "@playwright/test";

// Same trick as the smoke tests: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key and no network.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

interface Probe {
  scene: { traverse(cb: (o: any) => void): void };
}

const countBenches = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const map = (window as unknown as { __coolMap: Probe }).__coolMap;
    const counts = { total: 0, visible: 0 };
    map.scene.traverse((object: any) => {
      if (object.userData?.kind !== "bench") return;
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

test("benches are drawn and the checkbox hides them", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);

  // the default view is central Milan, which is full of benches
  await expect
    .poll(async () => (await countBenches(page)).total, { timeout: 20_000 })
    .toBeGreaterThan(0);

  // on by default, off when the checkbox is cleared, back on again
  expect((await countBenches(page)).visible).toBeGreaterThan(0);
  // the checkbox lives behind the layers gear
  await page.click("#layer-menu-button");
  await expect(page.locator("#benches-toggle")).toBeVisible();
  await page.click("#benches-toggle input");
  expect((await countBenches(page)).visible).toBe(0);
  await page.click("#benches-toggle input");
  expect((await countBenches(page)).visible).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
