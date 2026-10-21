import { test, expect } from "@playwright/test";

// Same trick as the smoke tests: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key and no network.
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

test("street furniture loads along a dense avenue", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/#map=18.3/45.478/9.209");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const map = (window as unknown as { __coolMap: any }).__coolMap;
          return map.stats().byKind.furniture?.meshes ?? 0;
        }),
      { timeout: 45_000 },
    )
    .toBeGreaterThan(0);

  const state = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: any }).__coolMap;
    let meshes = 0;
    let vertices = 0;
    map.customLayer.scene.traverse((object: any) => {
      if (object.userData?.kind !== "furniture") return;
      meshes += 1;
      vertices += object.geometry.getAttribute("position").count;
    });
    return {
      meshes,
      vertices,
      triangles: map.stats().byKind.furniture?.triangles ?? 0,
    };
  });

  expect(state.meshes).toBeGreaterThan(0);
  expect(state.vertices).toBeGreaterThan(500);
  expect(state.triangles).toBeGreaterThan(100);
  expect(errors).toEqual([]);
});
