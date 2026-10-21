import { test, expect } from "@playwright/test";

// tile parsing and SwiftShader are slow on this box
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

test("stop lines and lane arrows load at Viale Zara", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/#map=20.4/45.4926205/9.1930093/0/0");
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
          return map.stats().byKind.road_marking?.meshes ?? 0;
        }),
      { timeout: 45_000 },
    )
    .toBeGreaterThan(0);

  const state = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: any }).__coolMap;
    let meshes = 0;
    let vertices = 0;
    let maxHeight = 0;
    map.customLayer.scene.traverse((object: any) => {
      if (object.userData?.kind !== "road_marking") return;
      meshes += 1;
      vertices += object.geometry.getAttribute("position").count;
      object.geometry.computeBoundingBox();
      maxHeight = Math.max(maxHeight, object.geometry.boundingBox.max.z);
    });
    return {
      meshes,
      vertices,
      maxHeight,
      triangles: map.stats().byKind.road_marking?.triangles ?? 0,
    };
  });
  expect(state.meshes).toBeGreaterThan(0);
  expect(state.vertices).toBeGreaterThan(200);
  expect(state.maxHeight).toBeGreaterThan(0.03);
  expect(state.maxHeight).toBeLessThan(0.1);
  expect(state.triangles).toBeGreaterThan(100);

  // night: the paint is Lambert and dimmed, so it does not feed the bloom
  const night = await page.evaluate(() => {
    const slider = document.querySelector("#time-slider") as HTMLInputElement;
    slider.value = "1";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    let material: any = null;
    (
      window as unknown as { __coolMap: any }
    ).__coolMap.customLayer.scene.traverse((object: any) => {
      if (object.userData?.kind === "road_marking" && !material) {
        material = object.material;
      }
    });
    return { type: material?.type, r: material?.color?.r };
  });
  expect(night.type).toBe("MeshLambertMaterial");
  expect(night.r).toBeLessThan(0.5);

  const day = await page.evaluate(() => {
    const slider = document.querySelector("#time-slider") as HTMLInputElement;
    slider.value = "13";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    let material: any = null;
    (
      window as unknown as { __coolMap: any }
    ).__coolMap.customLayer.scene.traverse((object: any) => {
      if (object.userData?.kind === "road_marking" && !material) {
        material = object.material;
      }
    });
    return { r: material?.color?.r };
  });
  expect(day.r).toBeGreaterThan(0.9);
  expect(errors).toEqual([]);
});
