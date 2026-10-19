import { test, expect } from "@playwright/test";

// Same trick as the smoke tests: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key and no network.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

interface Probe {
  loadedBuildings: Record<string, unknown[]>;
  selectBuilding(info: unknown, lngLat: { lng: number; lat: number }): void;
}

test.beforeEach(async ({ page }) => {
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
});

// the popup inherits the page's text colour, so a dark browser preference used
// to paint white text onto maplibre's white popup background
test("the building popup stays readable in a dark color scheme", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            Object.values(
              (window as unknown as { __coolMap: Probe }).__coolMap
                .loadedBuildings,
            ).flat().length,
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: Probe }).__coolMap;
    const info = Object.values(map.loadedBuildings).flat()[0];
    map.selectBuilding(info, { lng: 9.186, lat: 45.497 });
  });

  const style = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(
      ".maplibregl-popup-content",
    );
    if (!element) return null;
    const computed = getComputedStyle(element);
    return {
      text: element.innerText,
      color: computed.color,
      background: computed.backgroundColor,
    };
  });
  expect(style).not.toBeNull();
  const luminance = (rgb: string) => {
    const [r, g, b] = (rgb.match(/\d+/g) ?? []).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  // dark text on a light popup, in either colour scheme
  expect(luminance(style!.color)).toBeLessThan(0.5);
  expect(luminance(style!.background)).toBeGreaterThan(0.5);
  expect(style!.text).toContain("Height:");
});
