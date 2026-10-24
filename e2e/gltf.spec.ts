import { test, expect } from "@playwright/test";
import { stat } from "node:fs/promises";

const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

test.beforeEach(async ({ page }) => {
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
});

test("a building popup downloads a GLB", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            Object.values(
              (window as unknown as { __coolMap: any }).__coolMap
                .loadedBuildings,
            ).flat().length,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: any }).__coolMap;
    const info = Object.values(map.loadedBuildings).flat()[0] as any;
    map.selectBuilding(info, map.map.getCenter());
  });
  const downloadPromise = page.waitForEvent("download");
  await page.locator("[data-gltf]").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.glb$/);
  const path = await download.path();
  expect(path).not.toBeNull();
  expect((await stat(path!)).size).toBeGreaterThan(100);
});
