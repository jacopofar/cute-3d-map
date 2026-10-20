import { test, expect } from "@playwright/test";

// Same mocked style as the other specs.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };
test.setTimeout(120_000);

interface Probe {
  map: { jumpTo(options: { center?: [number, number]; zoom?: number }): void };
  customLayer: { scene: { traverse(cb: (o: any) => void): void } };
}

const nightLights = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const map = (window as unknown as { __coolMap: Probe }).__coolMap;
    const out = {
      lamps: 0,
      lampPosts: 0,
      signals: 0,
      signalPosts: 0,
      lampsVisible: false,
      lampPostsVisible: false,
      signalsVisible: false,
      signalPostsVisible: false,
    };
    map.customLayer.scene.traverse((object: any) => {
      const kind = object.userData?.kind;
      if (kind === "lamplight") {
        out.lamps = object.geometry.getAttribute("position").count;
        out.lampsVisible = object.visible;
      } else if (kind === "lamppost") {
        out.lampPosts = object.count;
        out.lampPostsVisible = object.visible;
      } else if (kind === "signal_light") {
        out.signals = object.geometry.getAttribute("position").count;
        out.signalsVisible = object.visible;
      } else if (kind === "signal_post") {
        out.signalPosts = object.count;
        out.signalPostsVisible = object.visible;
      }
    });
    return out;
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

test("the lamp posts checkbox hides only the street lamps", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(
      () => page.evaluate(() => "__coolMap" in window).catch(() => false),
      { timeout: 60_000 },
    )
    .toBe(true);

  await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: Probe }).__coolMap;
    map.map.jumpTo({ center: [9.1919, 45.4641], zoom: 17.5 });
  });
  await page.evaluate(() => {
    const slider = document.querySelector("#time-slider");
    slider.value = "21.5";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // lamps and signal heads are built for the centre tiles and lit at night
  await expect
    .poll(
      async () => {
        const state = await nightLights(page);
        return state.lamps > 0 && state.lampsVisible;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const before = await nightLights(page);
  expect(before.signals).toBeGreaterThan(0);
  expect(before.signalsVisible).toBe(true);

  await page.click("#layer-menu-button");
  await expect(page.locator("#lampposts-toggle")).toBeVisible();
  await page.click("#lampposts-toggle input");

  const off = await nightLights(page);
  expect(off.lampsVisible).toBe(false);
  expect(off.lampPostsVisible).toBe(false);
  // the traffic signals are not lamp posts and stay on
  expect(off.signalsVisible).toBe(true);
  expect(off.signalPostsVisible).toBe(true);

  await page.click("#lampposts-toggle input");
  const back = await nightLights(page);
  expect(back.lampsVisible).toBe(true);
  expect(back.lampPostsVisible).toBe(true);

  expect(errors).toEqual([]);
});
