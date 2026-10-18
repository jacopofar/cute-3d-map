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

  // and the chevron folds the list away again
  await page.click("#layer-menu-collapse");
  await expect(page.locator("#layer-menu-panel")).toBeHidden();
  await expect(page.locator("#layer-menu-button")).toBeVisible();

  expect(errors).toEqual([]);
});

// a bridge way and a `man_made=bridge` deck over the Naviglio Grande; the tile
// set must have been regenerated with the bridge/tunnel pass for this to find
// any (see tilegen/main.py)
test("the bridges & tunnels toggle hides the deck and portal meshes", async ({
  page,
}) => {
  await page.goto("/#map=19/45.4503/9.16786");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await page.waitForFunction(() => "__coolMap" in window, null, {
    timeout: 20_000,
  });
  await expect
    .poll(async () => (await countMeshes(page, "bridge")).total, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);

  await page.click("#layer-menu-button");
  expect((await countMeshes(page, "bridge")).visible).toBeGreaterThan(0);
  await page.click("#bridges-toggle input");
  expect((await countMeshes(page, "bridge")).visible).toBe(0);
  expect((await countMeshes(page, "tunnel")).visible).toBe(0);
  await page.click("#bridges-toggle input");
  expect((await countMeshes(page, "bridge")).visible).toBeGreaterThan(0);
});

// the rail throat where the tracks dive under the city: the tunnel ways' ends
// become dark portal frames
test("a tunnel end draws a portal that the toggle can hide", async ({
  page,
}) => {
  await page.goto("/#map=19/45.48855/9.16085");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await page.waitForFunction(() => "__coolMap" in window, null, {
    timeout: 20_000,
  });
  await expect
    .poll(async () => (await countMeshes(page, "tunnel")).total, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);

  await page.click("#layer-menu-button");
  expect((await countMeshes(page, "tunnel")).visible).toBeGreaterThan(0);
  await page.click("#bridges-toggle input");
  expect((await countMeshes(page, "tunnel")).visible).toBe(0);
  await page.click("#bridges-toggle input");
  expect((await countMeshes(page, "tunnel")).visible).toBeGreaterThan(0);
});
