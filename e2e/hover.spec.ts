import { test, expect } from "@playwright/test";

import type { MapDebug } from "../src/debug";

// Same trick as the other specs: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key or network access.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

// boot + tile load + a few candidate buildings to sweep
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

const hoverKind = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __coolMap: MapDebug }).__coolMap.hoverState()
        .kind,
  );

const cursor = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      document.querySelector<HTMLElement>("canvas.maplibregl-canvas")?.style
        .cursor ?? "",
  );

// a ring of offsets around a canvas point: the exact centre can be a courtyard
// or a piazza, a few dozen pixels away is a wall
const SWEEP = [
  [0, 0],
  [0, -50],
  [0, 50],
  [-50, 0],
  [50, 0],
  [-50, -50],
  [50, -50],
  [-50, 50],
  [50, 50],
];

test("hovering rings a feature, and the checkbox turns it off", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __coolMap: MapDebug }).__coolMap.tiles.size,
        ),
      { timeout: 45_000 },
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(1500);

  const canvas = await page.locator("canvas.maplibregl-canvas").boundingBox();
  const at = (dx: number, dy: number) => ({
    x: canvas!.x + canvas!.width / 2 + dx,
    y: canvas!.y + canvas!.height / 2 + dy,
  });

  // off by default: sweeping the same points hovers nothing
  for (const [dx, dy] of SWEEP.slice(0, 3)) {
    await page.mouse.move(at(dx, dy).x, at(dx, dy).y);
    await page.waitForTimeout(120);
    expect(await hoverKind(page)).toBeNull();
  }

  // the checkbox lives behind the layers gear
  await page.click("#layer-menu-button");
  await page.click("#hover-inspect-toggle input");
  await page.click("#layer-menu-collapse");

  // Candidate buildings, biggest first. The default view centres on the Duomo's
  // piazza and the biggest footprint in the window can be a lonely chapel, so
  // the spec tries a few until something is actually under the cursor.
  const targets = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    const found: { lon: number; lat: number; area: number }[] = [];
    for (const tile of map.tiles.values()) {
      for (const b of tile.objects.buildings) {
        if (!b.bbox) continue;
        found.push({
          lon: (b.bbox[0] + b.bbox[2]) / 2,
          lat: (b.bbox[1] + b.bbox[3]) / 2,
          area: (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]),
        });
      }
    }
    found.sort((a, b) => b.area - a.area);
    return found.slice(0, 6);
  });
  if (targets.length === 0) throw new Error("no building in the loaded tiles");

  let hovered: string | null = null;
  for (const target of targets) {
    await page.evaluate((center) => {
      const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
      map.map.jumpTo({ center, zoom: 18 });
    }, target);
    await page.waitForTimeout(2500);
    for (const [dx, dy] of SWEEP) {
      await page.mouse.move(at(dx, dy).x, at(dx, dy).y);
      await page.waitForTimeout(150);
      hovered = await hoverKind(page);
      if (hovered) break;
    }
    if (hovered) break;
  }
  expect(hovered).not.toBeNull();
  expect(await cursor(page)).toBe("pointer");

  // switching it off drops the ring and the cursor
  await page.click("#layer-menu-button");
  await page.click("#hover-inspect-toggle input");
  await page.click("#layer-menu-collapse");
  await page.mouse.move(at(4, 4).x, at(4, 4).y);
  await page.waitForTimeout(250);
  expect(await hoverKind(page)).toBeNull();
  expect(await cursor(page)).toBe("");

  expect(errors).toEqual([]);
});
