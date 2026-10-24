import { test, expect } from "@playwright/test";

test.setTimeout(90_000);

test("the basemap checkbox removes and restores the MapTiler style", async ({
  page,
}) => {
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#e8e4dc" },
          },
        ],
      }),
    }),
  );

  await page.goto("/#map=17/45.464/9.19");
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);

  const layers = () =>
    page.evaluate(
      () =>
        (window as unknown as { __coolMap: any }).__coolMap.map.getStyle()
          .layers.length,
    );
  await expect.poll(layers, { timeout: 30_000 }).toBeGreaterThan(0);

  await page.evaluate(() =>
    document.querySelector<HTMLInputElement>("#basemap-toggle input")!.click(),
  );
  // the style swap is local, but under a loaded parallel suite it can queue
  // behind tile builds and WebGL work on the software renderer
  await expect.poll(layers, { timeout: 30_000 }).toBe(0);

  await page.evaluate(() =>
    document.querySelector<HTMLInputElement>("#basemap-toggle input")!.click(),
  );
  await expect.poll(layers, { timeout: 30_000 }).toBeGreaterThan(0);
});
