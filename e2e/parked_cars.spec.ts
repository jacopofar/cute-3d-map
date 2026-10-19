import { test, expect } from "@playwright/test";

// Same trick as the other specs: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key and no network.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

// parking + facade detail at zoom 17.5 is heavy under the software renderer
test.setTimeout(120_000);

// central Milan, above the facade-detail zoom where parked cars appear
const VIEW = { center: [9.1919, 45.4641], zoom: 17.5 };

interface Probe {
  map: { jumpTo(options: { center?: [number, number]; zoom?: number }): void };
  customLayer: { scene: { traverse(cb: (o: any) => void): void } };
}

const parkedCars = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const map = (window as unknown as { __coolMap: Probe }).__coolMap;
    const counts = { count: 0, visible: false };
    map.customLayer.scene.traverse((object: any) => {
      if (object.userData?.kind !== "parked_car") return;
      counts.count = object.count;
      counts.visible = object.visible;
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

test("parked cars appear at the windows zoom and follow their checkbox", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);

  await page.evaluate((view) => {
    const map = (window as unknown as { __coolMap: Probe }).__coolMap;
    map.map.jumpTo(view);
  }, VIEW);

  // the centre tiles load, tilegen's parking spots arrive, and the layer builds
  await expect
    .poll(async () => (await parkedCars(page)).count, { timeout: 60_000 })
    .toBeGreaterThan(0);
  expect((await parkedCars(page)).visible).toBe(true);

  // the checkbox lives behind the layers gear
  await page.click("#layer-menu-button");
  await expect(page.locator("#parked-cars-toggle")).toBeVisible();
  await page.click("#parked-cars-toggle input");
  expect((await parkedCars(page)).visible).toBe(false);
  await page.click("#parked-cars-toggle input");
  expect((await parkedCars(page)).visible).toBe(true);

  // below the facade-detail zoom the layer is hidden, like the windows
  await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: Probe }).__coolMap;
    map.map.jumpTo({ zoom: 16 });
  });
  await expect
    .poll(async () => (await parkedCars(page)).visible, { timeout: 10_000 })
    .toBe(false);

  expect(errors).toEqual([]);
});
