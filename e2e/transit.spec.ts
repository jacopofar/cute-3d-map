import { test, expect } from "@playwright/test";

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

test("the Duomo metro entrances load and open an OSM popup", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/#map=18.0/45.4641/9.1919");
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
          const stats = map.stats();
          return Math.min(
            stats.byKind.transit_stop?.meshes ?? 0,
            stats.byKind.metro_sign?.meshes ?? 0,
          );
        }),
      { timeout: 45_000 },
    )
    .toBeGreaterThan(0);

  const state = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: any }).__coolMap;
    const stats = map.stats();
    return {
      bodies: stats.byKind.transit_stop?.meshes ?? 0,
      signs: stats.byKind.metro_sign?.meshes ?? 0,
      triangles: stats.byKind.transit_stop?.triangles ?? 0,
    };
  });
  expect(state.bodies).toBeGreaterThan(0);
  expect(state.signs).toBeGreaterThan(0);
  expect(state.triangles).toBeGreaterThan(100);

  const target = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: any }).__coolMap;
    const container = map.map.getContainer() as HTMLElement;
    const infos = Object.values(map.loadedTransit ?? {}).flat() as Array<{
      kind: string;
      name?: string;
      lon: number;
      lat: number;
    }>;
    for (const info of infos) {
      if (info.kind !== "metro") continue;
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
  await expect(popup).toContainText("Metro entrance");
  await expect(popup).toContainText("OSM");
  if (target!.info.name) await expect(popup).toContainText(target!.info.name);
  expect(errors).toEqual([]);
});
