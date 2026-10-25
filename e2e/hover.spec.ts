import { test, expect } from "@playwright/test";

import type { MapDebug } from "../src/debug";

// Same trick as the other specs: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key and no network.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

// a building to centre on: the middle of a dense view is often a piazza, so
// the spec picks a real footprint and looks straight at its roof
const SOME_BUILDING = `/#map=18/45.497/9.186`;

// boot + tile load + two sweeps of hover checks
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

// the kinds a roof or a wall mesh carries; whichever the ray reaches first
const BUILDING_KINDS = ["building", "roof", "glass", "church"];

test("hovering rings a building, and the checkbox turns it off", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(SOME_BUILDING);
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);
  // the tiles have to be in before anything is under the cursor
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

  const target = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    for (const tile of map.tiles.values()) {
      for (const b of tile.objects.buildings) {
        if (!b.bbox) continue;
        return {
          lon: (b.bbox[0] + b.bbox[2]) / 2,
          lat: (b.bbox[1] + b.bbox[3]) / 2,
        };
      }
    }
    return null;
  });
  if (!target) throw new Error("no building in the loaded tiles");
  await page.evaluate((center) => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    map.map.jumpTo({ center, zoom: 19 });
  }, target);
  await page.waitForTimeout(3000);

  const canvas = await page.locator("canvas.maplibregl-canvas").boundingBox();
  const points = [
    [0, 0],
    [0, -40],
    [-60, -20],
    [60, -20],
    [0, 40],
  ];

  // off by default: sweeping the same points hovers nothing
  for (const [dx, dy] of points) {
    await page.mouse.move(
      canvas!.x + canvas!.width / 2 + dx,
      canvas!.y + canvas!.height / 2 + dy,
    );
    await page.waitForTimeout(120);
    expect(await hoverKind(page)).toBeNull();
  }

  // the checkbox lives behind the layers gear
  await page.click("#layer-menu-button");
  await page.click("#hover-inspect-toggle input");
  await page.click("#layer-menu-collapse");

  let hovered: string | null = null;
  for (const [dx, dy] of points) {
    await page.mouse.move(
      canvas!.x + canvas!.width / 2 + dx,
      canvas!.y + canvas!.height / 2 + dy,
    );
    await page.waitForTimeout(150);
    hovered = await hoverKind(page);
    if (hovered) break;
  }
  expect(BUILDING_KINDS).toContain(hovered);
  expect(await cursor(page)).toBe("pointer");

  // switching it off drops the ring and the cursor, on the same spot
  await page.click("#layer-menu-button");
  await page.click("#hover-inspect-toggle input");
  await page.click("#layer-menu-collapse");
  await page.mouse.move(
    canvas!.x + canvas!.width / 2,
    canvas!.y + canvas!.height / 2,
  );
  await page.waitForTimeout(250);
  expect(await hoverKind(page)).toBeNull();
  expect(await cursor(page)).toBe("");

  expect(errors).toEqual([]);
});
