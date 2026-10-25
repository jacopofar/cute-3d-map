import { test, expect } from "@playwright/test";
import type { MapDebug } from "../src/debug";

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

test("the Monumentale loads cemetery ground with tombstone rows", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // the Monumentale, a view within the permalink-fix margin of the default
  await page.goto("/#map=17.5/45.4875/9.1777");
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
          const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
          return map.stats().byKind.cemetery?.meshes ?? 0;
        }),
      { timeout: 45_000 },
    )
    .toBeGreaterThan(0);

  const state = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    let meshes = 0;
    let vertices = 0;
    map.scene.traverse((object: any) => {
      if (object.userData?.kind !== "cemetery") return;
      meshes += 1;
      vertices += object.geometry.getAttribute("position").count;
    });
    const kind = map.stats().byKind.cemetery;
    return {
      meshes,
      vertices,
      triangles: kind?.triangles ?? 0,
    };
  });

  expect(state.meshes).toBeGreaterThan(0);
  // the ground alone is a handful of triangles; this many vertices is the
  // tombstone rows, not just the clipped polygon
  expect(state.vertices).toBeGreaterThan(2000);
  expect(state.triangles).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
});
