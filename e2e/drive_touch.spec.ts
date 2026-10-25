import { test, expect } from "@playwright/test";

// Same trick as the other specs: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key and no network.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

// a phone-sized, touch-first viewport: the CSS should show the thumb controls
test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
});

// booting the map and loading the first tile window is slow under the software
// renderer, and the touch hold needs a couple of seconds of driving
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
});

const driveState = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __coolMap: {
          driveState(): {
            active: boolean;
            lon: number;
            lat: number;
            heading: number;
            speed: number;
          };
        };
      }
    ).__coolMap.driveState(),
  );

test("touch controls steer and drive the car", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);

  // the Drive row is in the layers menu, as on desktop
  await page.click("#layer-menu-button");
  await page.click("#drive-button");
  await expect(page.locator("#layer-menu-panel")).toBeHidden();
  await expect(page.locator("#drive-touch")).toBeVisible();
  // the keyboard hint has no place on a touch screen
  await expect(page.locator("#drive-hud .drive-hint")).toBeHidden();

  const start = await driveState(page);
  expect(start.active).toBe(true);

  const forward = page.locator('[data-drive-action="forward"]');
  const left = page.locator('[data-drive-action="left"]');
  // synthetic pointers: a test cannot hold two real touches at once, and the
  // handler tolerates the failed capture
  await forward.dispatchEvent("pointerdown", {
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    buttons: 1,
  });
  await left.dispatchEvent("pointerdown", {
    pointerId: 2,
    pointerType: "touch",
    buttons: 1,
  });

  await expect
    .poll(async () => (await driveState(page)).speed, { timeout: 15_000 })
    .toBeGreaterThan(1);
  await page.waitForTimeout(900);
  const moving = await driveState(page);
  expect(moving.active).toBe(true);
  expect(
    Math.hypot(moving.lon - start.lon, moving.lat - start.lat),
  ).toBeGreaterThan(0.00005);
  expect(Math.abs(moving.heading - start.heading)).toBeGreaterThan(0.02);
  expect(moving.speed).toBeGreaterThan(1);

  await forward.dispatchEvent("pointerup", {
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
  });
  await left.dispatchEvent("pointerup", {
    pointerId: 2,
    pointerType: "touch",
  });

  // releasing the pedals lets the car coast down
  await expect
    .poll(async () => (await driveState(page)).speed, { timeout: 10_000 })
    .toBeLessThan(moving.speed);

  // Escape is still the universal way out, and it hides the pad
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await driveState(page)).active, { timeout: 10_000 })
    .toBe(false);
  await expect(page.locator("#drive-touch")).toBeHidden();

  expect(errors).toEqual([]);
});
