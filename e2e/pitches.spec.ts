import { test, expect } from "@playwright/test";

import type { MapDebug } from "../src/debug";

// Same trick as the other specs: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key or network access.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

// boot + tile load + the visibility sweeps
test.setTimeout(120_000);

// the sports ground north of Parco Ravizza: tennis, soccer, basketball and
// volleyball pitches inside one window
const COURTS = "#map=17/45.4463/9.1478";

test.beforeEach(async ({ page }) => {
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
});

const count = (page: import("@playwright/test").Page, kind: string) =>
  page.evaluate((wanted) => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    const counts = { total: 0, visible: 0 };
    map.scene.traverse((object) => {
      if (object.userData?.kind !== wanted) return;
      counts.total += 1;
      if (object.visible) counts.visible += 1;
    });
    return counts;
  }, kind);

// an athletics track north of the city: the tartan ring with its lanes, and the
// infield pitch inside it
const TRACK = "#map=17.2/45.43789/9.08315";

test("a running track paints its lanes and names itself in the popup", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/${TRACK}`);
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);

  // the tile data carries the track as a green with the athletics sport
  const athletics = () =>
    page.evaluate(() => {
      const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
      let found = 0;
      for (const record of map.tiles.values()) {
        for (const info of record.objects.features) {
          if (info.kind === "green" && info.sport === "athletics") found += 1;
        }
      }
      return found;
    });
  await expect.poll(athletics, { timeout: 60_000 }).toBeGreaterThan(0);

  // the tartan and the lanes are drawn like any other court
  for (const kind of ["pitch", "pitch_paint"]) {
    await expect
      .poll(async () => (await count(page, kind)).visible, { timeout: 20_000 })
      .toBeGreaterThan(0);
  }

  // Click on the tartan band, five metres inside its northern edge. The paint
  // and the tint are not pickable, so the click lands on the green feature
  // underneath, which is what names the track.
  const point = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    const rect = map.map.getCanvas().getBoundingClientRect();
    // the window holds dozens of tiles: take a track that is actually on screen
    for (const record of map.tiles.values()) {
      for (const info of record.objects.features) {
        if (info.kind !== "green" || info.sport !== "athletics") continue;
        const outer = info.rings?.[0];
        if (!outer) continue;
        let top: [number, number] = outer[0];
        for (const vertex of outer) {
          if (vertex[1] > top[1]) top = vertex;
        }
        // a lane band is ~10 m wide, so 5 m south of the outermost vertex is
        // still the tartan
        const projected = map.map.project([top[0], top[1] - 5 / 111_320]);
        const x = projected.x + rect.left;
        const y = projected.y + rect.top;
        const onScreen =
          x >= 0 && x <= rect.width && y >= 0 && y <= rect.height;
        if (onScreen) return { x, y };
      }
    }
    throw new Error("no athletics track on screen");
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".maplibregl-popup-content")).toContainText(
    "Athletics track",
  );

  expect(errors).toEqual([]);
});

test("a floodlit ground lights up at night, and its checkbox takes the light with it", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/${TRACK}`);
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);

  // the time slider is how the spec forces night
  await page.evaluate(() => {
    const slider = document.querySelector<HTMLInputElement>("#time-slider");
    if (!slider) throw new Error("no #time-slider");
    slider.value = "21.5";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const floods = () =>
    page.evaluate(() => {
      const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
      const out = { total: 0, visible: false, masts: 0 };
      map.scene.traverse((object) => {
        const kind = object.userData?.kind;
        if (kind === "floodlight" || kind === "floodlight_pool") {
          out.total += 1;
          out.visible ||= object.visible;
        } else if (kind === "floodlight_mast") {
          out.masts += 1;
        }
      });
      return out;
    });
  await expect
    .poll(async () => (await floods()).visible, { timeout: 30_000 })
    .toBe(true);
  expect((await floods()).masts).toBeGreaterThan(0);

  // the floodlights belong to the court: hiding the pitches hides the light,
  // and the street lamps are a different row
  await page.click("#layer-menu-button");
  await page.click("#pitches-toggle input");
  await expect
    .poll(async () => (await floods()).visible, { timeout: 15_000 })
    .toBe(false);
  await page.click("#pitches-toggle input");
  await expect
    .poll(async () => (await floods()).visible, { timeout: 15_000 })
    .toBe(true);

  expect(errors).toEqual([]);
});

test("pitches draw their court and paint, and the checkbox hides just those", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/${COURTS}`);
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);

  // both kinds come from the same green feature: the court mesh and the lines
  await expect
    .poll(async () => (await count(page, "pitch")).total, { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await count(page, "pitch_paint")).total, {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  expect((await count(page, "pitch")).visible).toBeGreaterThan(0);
  expect((await count(page, "pitch_paint")).visible).toBeGreaterThan(0);

  // the checkbox lives behind the layers gear
  await page.click("#layer-menu-button");
  await expect(page.locator("#pitches-toggle")).toBeVisible();
  await page.click("#pitches-toggle input");
  expect((await count(page, "pitch")).visible).toBe(0);
  expect((await count(page, "pitch_paint")).visible).toBe(0);
  // the lawn underneath is the parks layer, and it stays
  expect((await count(page, "green")).visible).toBeGreaterThan(0);
  await page.click("#pitches-toggle input");
  expect((await count(page, "pitch")).visible).toBeGreaterThan(0);
  await page.click("#layer-menu-collapse");

  // court paint is a street-level detail: gated on the zoom like the lanes
  await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    map.map.jumpTo({ zoom: 13 });
  });
  await expect
    .poll(async () => (await count(page, "pitch")).visible, { timeout: 15_000 })
    .toBe(0);
  await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    map.map.jumpTo({ zoom: 17 });
  });
  await expect
    .poll(async () => (await count(page, "pitch")).visible, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
