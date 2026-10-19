import { test, expect } from "@playwright/test";

// Same trick as the smoke tests: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key and no network.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

// the facade detail only builds above zoom 17, and a tile's worth of it is
// heavy, so this test takes longer than the default budget
test.setTimeout(120_000);

interface Probe {
  map: { jumpTo(options: { zoom: number }): void };
  customLayer: {
    scene: { traverse(cb: (o: any) => void): void };
  };
}

const countMeshes = (page: import("@playwright/test").Page, kind: string) =>
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

test("the layer menu folds the checkboxes behind a gear button", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await page.waitForFunction(() => "__coolMap" in window, null, {
    timeout: 20_000,
  });
  await expect
    .poll(async () => (await countMeshes(page, "roof")).total, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);

  // collapsed: only the gear, then the list behind the chevron
  await expect(page.locator("#layer-menu-button")).toBeVisible();
  await expect(page.locator("#layer-menu-panel")).toBeHidden();
  await expect(page.locator("#roof-shapes-toggle")).toBeHidden();

  await page.click("#layer-menu-button");
  await expect(page.locator("#layer-menu-panel")).toBeVisible();
  await expect(page.locator("#layer-menu-button")).toBeHidden();
  await expect(page.locator("#roof-shapes-toggle")).toBeVisible();

  // the question mark explains the imputed colours
  await expect(page.locator("#imputed-help-text")).toBeHidden();
  await page.click("#imputed-help");
  await expect(page.locator("#imputed-help-text")).toBeVisible();
  await page.click("#imputed-help");
  await expect(page.locator("#imputed-help-text")).toBeHidden();

  // roofs: on by default, off when the checkbox is cleared
  expect((await countMeshes(page, "roof")).visible).toBeGreaterThan(0);
  await page.click("#roof-shapes-toggle input");
  expect((await countMeshes(page, "roof")).visible).toBe(0);
  await page.click("#roof-shapes-toggle input");
  expect((await countMeshes(page, "roof")).visible).toBeGreaterThan(0);

  // water: same, its own mesh per tile
  await expect
    .poll(async () => (await countMeshes(page, "water")).total, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  expect((await countMeshes(page, "water")).visible).toBeGreaterThan(0);
  await page.click("#water-toggle input");
  expect((await countMeshes(page, "water")).visible).toBe(0);
  await page.click("#water-toggle input");
  expect((await countMeshes(page, "water")).visible).toBeGreaterThan(0);

  // the facade detail needs the zoom gate to open
  await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: Probe }).__coolMap;
    map.map.jumpTo({ zoom: 18 });
  });
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const map = (window as unknown as { __coolMap: Probe }).__coolMap;
          let total = 0;
          map.customLayer.scene.traverse((object: any) => {
            if (object.userData?.group === "windows") total += 1;
          });
          return total;
        }),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  await page.click("#windows-toggle input");
  const windowsHidden = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: Probe }).__coolMap;
    let hidden = 0;
    map.customLayer.scene.traverse((object: any) => {
      if (object.userData?.group === "windows" && !object.visible) hidden += 1;
    });
    return hidden;
  });
  expect(windowsHidden).toBeGreaterThan(0);
  await page.click("#windows-toggle input");

  // fences ride on the same zoom gate, so the jump above is what shows them
  await expect
    .poll(async () => (await countMeshes(page, "fence")).total, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  expect((await countMeshes(page, "fence")).visible).toBeGreaterThan(0);
  await page.click("#fences-toggle input");
  expect((await countMeshes(page, "fence")).visible).toBe(0);
  await page.click("#fences-toggle input");
  expect((await countMeshes(page, "fence")).visible).toBeGreaterThan(0);

  // and the chevron folds the list away again
  await page.click("#layer-menu-collapse");
  await expect(page.locator("#layer-menu-panel")).toBeHidden();
  await expect(page.locator("#layer-menu-button")).toBeVisible();

  expect(errors).toEqual([]);
});

// read the day/night state the app exposes, plus the window shader's night
// uniform (via the shared material on a windows mesh)
const readDayNight = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const map = (window as unknown as { __coolMap: any }).__coolMap;
    let uNight = null;
    map.customLayer.scene.traverse((object: any) => {
      if (object.userData?.group !== "windows") return;
      const value = object.material?.uniforms?.uNight?.value;
      if (typeof value === "number") uNight = value;
    });
    return { ...map.lightingState(), uNight };
  });

test("the night toggle darkens the scene and lights the windows", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await page.waitForFunction(() => "__coolMap" in window, null, {
    timeout: 20_000,
  });

  // open the layers menu (the checkboxes are behind the gear)
  await page.click("#layer-menu-button");
  await expect(page.locator("#night-toggle")).toBeVisible();

  // day by default: 13:00, no night, a bright key light
  const day = await readDayNight(page);
  expect(day.hour).toBe(13);
  expect(day.night).toBe(0);
  expect(day.sunIntensity).toBeGreaterThan(2);
  expect(await page.locator("#night-toggle input").isChecked()).toBe(false);

  // the night checkbox is the shortcut: it jumps to 01:00
  await page.click("#night-toggle input");
  await expect
    .poll(async () => (await readDayNight(page)).night, { timeout: 10_000 })
    .toBe(1);
  const night = await readDayNight(page);
  expect(night.hour).toBe(1);
  expect(night.sunIntensity).toBeLessThan(0.5);

  // the window meshes use the shader material, so the uniform reaches them:
  // zoom in so the facade detail exists, then confirm uNight is night
  await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: any }).__coolMap;
    map.map.jumpTo({ zoom: 18 });
  });
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const map = (window as unknown as { __coolMap: any }).__coolMap;
          let total = 0;
          map.customLayer.scene.traverse((object: any) => {
            if (object.userData?.group === "windows") total += 1;
          });
          return total;
        }),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  expect((await readDayNight(page)).uNight).toBe(1);

  // the slider drives the same model and syncs the checkbox back
  await page.fill("#time-slider", "12");
  await expect
    .poll(async () => (await readDayNight(page)).night, { timeout: 10_000 })
    .toBe(0);
  expect((await readDayNight(page)).uNight).toBe(0);
  expect(await page.locator("#night-toggle input").isChecked()).toBe(false);
  await page.fill("#time-slider", "22");
  await expect
    .poll(async () => (await readDayNight(page)).night, { timeout: 10_000 })
    .toBe(1);
  expect(await page.locator("#night-toggle input").isChecked()).toBe(true);

  expect(errors).toEqual([]);
});
