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

test("Lambrate platforms and rails load and a platform opens a popup", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/#map=19.2/45.48476/9.23723/0/0");
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
          return {
            platforms: map.stats().byKind.platform?.meshes ?? 0,
            rails: map.stats().byKind.rail?.meshes ?? 0,
          };
        }),
      { timeout: 45_000 },
    )
    .toMatchObject({
      platforms: expect.any(Number),
      rails: expect.any(Number),
    });

  const state = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: any }).__coolMap;
    let platformMeshes = 0;
    let railMeshes = 0;
    map.customLayer.scene.traverse((object: any) => {
      if (object.userData?.kind === "platform") platformMeshes += 1;
      if (object.userData?.kind === "rail") railMeshes += 1;
    });
    return { platformMeshes, railMeshes };
  });
  expect(state.platformMeshes).toBeGreaterThan(0);
  expect(state.railMeshes).toBeGreaterThan(0);

  let target: { p: { x: number; y: number } } | null = null;
  await expect
    .poll(
      async () => {
        target = await page.evaluate(() => {
          const map = (window as unknown as { __coolMap: any }).__coolMap;
          const container = map.map.getContainer() as HTMLElement;
          const camera = map.customLayer.camera;
          let found: { p: { x: number; y: number } } | null = null;
          map.customLayer.scene.traverse((object: any) => {
            if (found || object.userData?.kind !== "platform") return;
            const pos = object.geometry.getAttribute("position");
            for (let i = 0; i + 2 < pos.count; i += 3) {
              const z = pos.getZ(i);
              if (z < 0.2) continue;
              const v = new camera.position.constructor(
                (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3,
                (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3,
                z,
              );
              object.updateMatrixWorld(true);
              v.applyMatrix4(object.matrixWorld).project(camera);
              const x = ((v.x + 1) / 2) * container.clientWidth;
              const y = ((1 - v.y) / 2) * container.clientHeight;
              if (
                x > 100 &&
                y > 100 &&
                x < container.clientWidth - 100 &&
                y < container.clientHeight - 100
              ) {
                found = { p: { x, y } };
                break;
              }
            }
          });
          return found;
        });
        return target !== null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  const canvas = await page.locator("canvas.maplibregl-canvas").boundingBox();
  await page.mouse.click(canvas!.x + target!.p.x, canvas!.y + target!.p.y);
  const popup = page.locator(".maplibregl-popup-content");
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect(popup).toContainText(/rail platform/i);
  await expect(popup).toContainText("OSM");

  const hidden = await page.evaluate(() => {
    const input = document.querySelector(
      "#transit-toggle input",
    ) as HTMLInputElement;
    input.click();
    let visible = 0;
    (
      window as unknown as { __coolMap: any }
    ).__coolMap.customLayer.scene.traverse((object: any) => {
      if (
        (object.userData?.kind === "platform" ||
          object.userData?.kind === "rail") &&
        object.visible
      ) {
        visible += 1;
      }
    });
    return visible;
  });
  expect(hidden).toBe(0);
  expect(errors).toEqual([]);
});
