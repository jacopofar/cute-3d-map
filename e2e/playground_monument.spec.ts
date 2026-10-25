import { test, expect } from "@playwright/test";
import type { MapDebug } from "../src/debug";

// tile parsing and SwiftShader are slow on this box; the click probes need room
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

async function clickFirst(
  page: import("@playwright/test").Page,
  kind: string,
  listName: string,
): Promise<{ name?: string }> {
  const target = await page.evaluate(
    ({ listName }) => {
      const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
      const container = map.map.getContainer() as HTMLElement;
      const infos = [...map.tiles.values()].flatMap(
        (t) => (t.objects as Record<string, any>)[listName],
      ) as Array<{
        name?: string;
        lon: number;
        lat: number;
      }>;
      for (const info of infos) {
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
    },
    { listName },
  );
  expect(target, kind).not.toBeNull();
  const canvas = await page.locator("canvas.maplibregl-canvas").boundingBox();
  await page.mouse.click(canvas!.x + target!.p.x, canvas!.y + target!.p.y);
  const popup = page.locator(".maplibregl-popup-content");
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect(popup).toContainText("OSM");
  return target!.info;
}

test("playgrounds load and open an OSM popup", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#map=18.5/45.4843/9.1849");
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
          return map.stats().byKind.playground?.meshes ?? 0;
        }),
      { timeout: 45_000 },
    )
    .toBeGreaterThan(0);
  const info = await clickFirst(page, "playground", "playgrounds");
  const popup = page.locator(".maplibregl-popup-content");
  await expect(popup).toContainText("Playground");
  if (info.name) await expect(popup).toContainText(info.name);
  expect(errors).toEqual([]);
});

test("monuments load and open an OSM popup", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#map=18.5/45.4782/9.1848");
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
          return map.stats().byKind.monument?.meshes ?? 0;
        }),
      { timeout: 45_000 },
    )
    .toBeGreaterThan(0);
  const info = await clickFirst(page, "monument", "monuments");
  const popup = page.locator(".maplibregl-popup-content");
  await expect(popup).toContainText(
    /monument|memorial|statue|bust|plaque|obelisk|stele/i,
  );
  if (info.name) await expect(popup).toContainText(info.name);
  expect(errors).toEqual([]);
});
