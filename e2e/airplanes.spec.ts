import { test, expect } from "@playwright/test";

// Same trick as the other specs: a minimal valid style so the map reaches
// "style.load" with no MapTiler key and no network.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

// Linate: the default Milan view has no runway, so the test has to fly there
const LINATE = { center: [9.2706, 45.4444], zoom: 17 };

interface Probe {
  map: { jumpTo(options: { center: [number, number]; zoom: number }): void };
  customLayer: { scene: { traverse(cb: (o: any) => void): void } };
}

const countKind = (page: import("@playwright/test").Page, kind: string) =>
  page.evaluate((wanted) => {
    const map = (window as unknown as { __coolMap: Probe }).__coolMap;
    const counts = { total: 0, visible: 0 };
    map.customLayer.scene.traverse((object: any) => {
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

test("the runway surface and planes appear at Linate and follow the toggle", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await page.waitForFunction(() => "__coolMap" in window, null, {
    timeout: 20_000,
  });
  await page.evaluate((place) => {
    const map = (window as unknown as { __coolMap: Probe }).__coolMap;
    map.map.jumpTo(place);
  }, LINATE);

  // the tarmac tiles load and merge into a per-tile aeroway mesh. Poll the
  // *visible* count: a mesh from the start view (Bresso is far enough to have a
  // runway in the default window) can be in the scene for a moment before the
  // move's unload pass drops it, which would fool a poll on the total.
  await expect
    .poll(async () => (await countKind(page, "aeroway")).visible, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  expect((await countKind(page, "aeroway")).total).toBeGreaterThan(0);

  // the decorative plane layer is one instanced mesh, present but only drawn
  // now and then
  expect((await countKind(page, "airplane")).total).toBe(1);

  // the one checkbox hides the surface (and the planes with it)
  await page.click("#layer-menu-button");
  await page.click("#airplanes-toggle input");
  expect((await countKind(page, "aeroway")).visible).toBe(0);
  await page.click("#airplanes-toggle input");
  expect((await countKind(page, "aeroway")).visible).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
