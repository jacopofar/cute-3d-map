import { test, expect } from "@playwright/test";
import type { MapDebug } from "../src/debug";

// tile parsing and SwiftShader are slow on this box; the click probe needs room
test.setTimeout(90_000);

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

test("zebra crossings load and open an OSM popup", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/#map=19.79/45.4927129/9.1929893/0/0");
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
          return map.stats().byKind.crosswalk?.meshes ?? 0;
        }),
      { timeout: 45_000 },
    )
    .toBeGreaterThan(0);

  const state = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    let meshes = 0;
    let vertices = 0;
    map.scene.traverse((object: any) => {
      if (object.userData?.kind !== "crosswalk") return;
      meshes += 1;
      vertices += object.geometry.getAttribute("position").count;
    });
    return {
      meshes,
      vertices,
      triangles: map.stats().byKind.crosswalk?.triangles ?? 0,
    };
  });
  expect(state.meshes).toBeGreaterThan(0);
  expect(state.vertices).toBeGreaterThan(100);
  expect(state.triangles).toBeGreaterThan(50);

  let target: {
    info: { id?: string; lon: number; lat: number };
    p: { x: number; y: number };
  } | null = null;
  await expect
    .poll(
      async () => {
        target = await page.evaluate(() => {
          const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
          const container = map.map.getContainer() as HTMLElement;
          for (const info of [...map.tiles.values()]
            .map((t) => t.objects.crosswalks)
            .flat() as Array<{
            id?: string;
            lon: number;
            lat: number;
          }>) {
            const p = map.map.project([info.lon, info.lat]);
            if (
              p.x > 80 &&
              p.y > 80 &&
              p.x < container.clientWidth - 80 &&
              p.y < container.clientHeight - 80
            ) {
              return { info, p };
            }
          }
          return null;
        });
        return target !== null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  expect(target).not.toBeNull();

  const canvas = await page.locator("canvas.maplibregl-canvas").boundingBox();
  await page.mouse.click(canvas!.x + target!.p.x, canvas!.y + target!.p.y);
  const popup = page.locator(".maplibregl-popup-content");
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect(popup).toContainText(/zebra crossing/i);
  await expect(popup).toContainText("OSM");
  expect(errors).toEqual([]);
});
