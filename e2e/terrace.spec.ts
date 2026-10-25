import { test, expect } from "@playwright/test";

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

test("outdoor terraces load in Brera and open an OSM popup", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/#map=18.6/45.4781/9.1847");
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
          return map.stats().byKind.terrace?.meshes ?? 0;
        }),
      { timeout: 45_000 },
    )
    .toBeGreaterThan(0);

  const state = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: any }).__coolMap;
    let meshes = 0;
    let vertices = 0;
    map.customLayer.scene.traverse((object: any) => {
      if (object.userData?.kind !== "terrace") return;
      meshes += 1;
      vertices += object.geometry.getAttribute("position").count;
    });
    return {
      meshes,
      vertices,
      triangles: map.stats().byKind.terrace?.triangles ?? 0,
    };
  });
  expect(state.meshes).toBeGreaterThan(0);
  expect(state.vertices).toBeGreaterThan(200);
  expect(state.triangles).toBeGreaterThan(100);

  const target = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: any }).__coolMap;
    const container = map.map.getContainer() as HTMLElement;
    const infos = [...map.tiles.values()]
      .map((t) => t.objects.terraces)
      .flat() as Array<{
      name?: string;
      kind: string;
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
  });
  expect(target).not.toBeNull();

  const canvas = await page.locator("canvas.maplibregl-canvas").boundingBox();
  await page.mouse.click(canvas!.x + target!.p.x, canvas!.y + target!.p.y);
  const popup = page.locator(".maplibregl-popup-content");
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect(popup).toContainText(/terrace|beer garden/i);
  await expect(popup).toContainText("OSM");
  if (target!.info.name) await expect(popup).toContainText(target!.info.name);
  expect(errors).toEqual([]);
});
