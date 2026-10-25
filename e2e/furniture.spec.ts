import { test, expect } from "@playwright/test";
import type { MapDebug } from "../src/debug";

// tile parsing and SwiftShader are slow on this box; the click probes need room
test.setTimeout(90_000);

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
          const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
          return map.stats().byKind.furniture?.meshes ?? 0;
        }),
      { timeout: 45_000 },
    )
    .toBeGreaterThan(0);

  const state = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    let meshes = 0;
    let vertices = 0;
    map.scene.traverse((object: any) => {
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

test("clicking a furniture prop opens its OSM popup", async ({ page }) => {
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
          const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
          return map.stats().byKind.furniture?.meshes ?? 0;
        }),
      { timeout: 45_000 },
    )
    .toBeGreaterThan(0);

  const target = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    const container = map.map.getContainer() as HTMLElement;
    const infos = [...map.tiles.values()]
      .map((t) => t.objects.furniture)
      .flat() as Array<{
      kind: string;
      lon: number;
      lat: number;
    }>;
    for (const info of infos) {
      const p = map.map.project([info.lon, info.lat]);
      if (
        p.x > 60 &&
        p.y > 60 &&
        p.x < container.clientWidth - 60 &&
        p.y < container.clientHeight - 60
      ) {
        return { info, p };
      }
    }
    return null;
  });
  expect(target).not.toBeNull();

  const canvas = await page.locator("canvas.maplibregl-canvas").boundingBox();
  await page.mouse.click(canvas!.x + target!.p.x, canvas!.y + target!.p.y);
  const popup = page.locator(".maplibregl-popup-content");
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect(popup).toContainText("OSM");
  await expect(popup).toContainText(
    /bollard|waste|bicycle|post box|drinking|information|hydrant/i,
  );
  expect(errors).toEqual([]);
});
