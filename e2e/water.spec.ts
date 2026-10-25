import { test, expect } from "@playwright/test";
import type { MapDebug } from "../src/debug";

// minimal valid style, same trick as the other specs (no MapTiler key/network)
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

test("clicking water shows its kind and an OSM link", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#map=16.5/45.4575/9.174");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);
  await page.waitForFunction(
    () => {
      const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
      return [...map.tiles.values()]
        .map((t) => t.objects.water)
        .some((tiles: any) =>
          tiles.some((w: any) => w.lines.length > 0 || w.rings.length > 0),
        );
    },
    null,
    { timeout: 20_000 },
  );

  // project a few water points (waterway midpoints, area ring centres) to the
  // screen and click until one opens a popup that is not a building's
  const points = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const all = [...map.tiles.values()]
      .map((t) => t.objects.water)
      .flat() as any[];
    const points: { x: number; y: number }[] = [];
    for (const water of all) {
      const candidates: [number, number][] = [];
      for (const line of water.lines) {
        candidates.push(line[Math.floor(line.length / 2)]);
      }
      for (const ring of water.rings) {
        candidates.push([
          ring.reduce((s: number, c: number[]) => s + c[0], 0) / ring.length,
          ring.reduce((s: number, c: number[]) => s + c[1], 0) / ring.length,
        ]);
      }
      for (const candidate of candidates) {
        const p = map.map.project(candidate);
        // keep it clear of the edges (and the layers menu at the top left)
        if (p.x > 60 && p.y > 60 && p.x < width - 60 && p.y < height - 60) {
          points.push({ x: p.x, y: p.y });
        }
      }
    }
    return points.slice(0, 25);
  });

  const popup = page.locator(".maplibregl-popup-content");
  let clickedWater = false;
  for (const point of points) {
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(120);
    if ((await popup.count()) === 0) continue;
    const text = await popup.innerText();
    if (!text.includes("Height:")) {
      // water, not a building
      expect(text).toContain("OSM");
      clickedWater = true;
      break;
    }
  }
  expect(clickedWater).toBe(true);
  expect(errors).toEqual([]);
});
