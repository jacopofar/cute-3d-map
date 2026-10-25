import { test, expect } from "@playwright/test";

/*
 * Scene health on the real GPU, run before the frame-time benchmark.
 *
 * The headless suite renders on SwiftShader, where the app switches the shadow
 * pass off, so it cannot see anything that goes wrong in the shadow path. On a
 * real GPU a light that casts shadows with no baked shadow map makes every
 * shadow-sampling draw fail with GL_INVALID_OPERATION, which hides most of the
 * scene while the unlit shaders (windows) and the click popups keep working —
 * see `db56144`. This is the cheap assertion that catches that class of bug.
 */

const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
});

test("the GPU scene has a baked shadow map and no GL errors", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await page.waitForFunction(() => "__coolMap" in window, null, {
    timeout: 20_000,
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __coolMap: { tiles: Map<string, unknown> };
              }
            ).__coolMap.tiles.size,
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  // the tile burst plus a couple of frames, so the shadow bake has happened
  await page.waitForTimeout(4000);

  const shadow = await page.evaluate(() =>
    (
      window as unknown as {
        __coolMap: { shadowState(): { castsShadow: boolean; baked: boolean } };
      }
    ).__coolMap.shadowState(),
  );

  // on a machine without a GPU Chrome falls back to software and the pass is
  // off by design; the frame-time bench still runs, this assertion does not apply
  if (shadow.castsShadow) {
    expect(shadow.baked, "the sun must have baked its shadow map").toBe(true);
  }

  // read the app's own WebGL context (same canvas, same context object) over a
  // handful of frames: a failed draw surfaces here as a non-zero error
  const errors = await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      "canvas.maplibregl-canvas",
    );
    const gl = canvas?.getContext("webgl2");
    if (!gl) return [-1];
    const map = (
      window as unknown as { __coolMap: { map: { triggerRepaint(): void } } }
    ).__coolMap;
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) {
      map.map.triggerRepaint();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const error = gl.getError();
      if (error !== 0) seen.push(error);
    }
    return seen;
  });
  expect(errors, "WebGL errors while rendering").toEqual([]);
});
