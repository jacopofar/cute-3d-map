import { test, expect } from "@playwright/test";
import type { MapDebug } from "../src/debug";

// Same trick as the other specs: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key and no network.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

// booting the map and loading the first tile window is slow under the software
// renderer in CI
test.setTimeout(120_000);

interface DriveProbe {
  driveState(): {
    active: boolean;
    lon: number;
    lat: number;
    heading: number;
    speed: number;
  };
  map: {
    getCenter(): { lng: number; lat: number };
    getBearing(): number;
    getPitch(): number;
    dragPan: { isEnabled(): boolean };
  };
  scene: { traverse(cb: (o: any) => void): void };
}

const probe = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const map = (window as unknown as { __coolMap: DriveProbe }).__coolMap;
    let carVisible: boolean | null = null;
    map.scene.traverse((object: any) => {
      if (object.userData?.kind === "driving_car") carVisible = object.visible;
    });
    return {
      state: map.driveState(),
      center: map.map.getCenter(),
      bearing: map.map.getBearing(),
      pitch: map.map.getPitch(),
      dragPan: map.map.dragPan.isEnabled(),
      carVisible,
    };
  });

test.beforeEach(async ({ page }) => {
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
});

test("drive mode follows a WASD car and exits cleanly", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);

  // the button lives in the layers menu: open the gear, then enter the mode
  await page.click("#layer-menu-button");
  await page.click("#drive-button");
  // entering closes the menu so the chase camera is visible
  await expect(page.locator("#layer-menu-panel")).toBeHidden();
  const entered = await probe(page);
  expect(entered.state.active).toBe(true);
  expect(entered.carVisible).toBe(true);
  expect(entered.dragPan).toBe(false);
  await expect(page.locator("#drive-button")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#drive-hud")).toBeVisible();

  // W drives the car forward, well before the 60 km/h cap
  const start = entered.state;
  await page.keyboard.down("w");
  await expect
    .poll(
      async () => {
        const now = await probe(page);
        return Math.hypot(now.state.lon - start.lon, now.state.lat - start.lat);
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0.00012); // ~13 m
  await page.keyboard.up("w");

  // the camera looks where the car is going, a little ahead of it
  const moving = await probe(page);
  expect(moving.state.speed).not.toBe(0);
  expect(moving.pitch).toBeCloseTo(55, 0);
  expect(
    Math.hypot(
      moving.center.lng - moving.state.lon,
      moving.center.lat - moving.state.lat,
    ),
  ).toBeLessThan(0.005);
  // a heading of pi/2 points north; MapLibre's bearing is clockwise from north
  const norm = (deg: number) => ((deg + 540) % 360) - 180;
  const expectedBearing = 90 - (moving.state.heading * 180) / Math.PI;
  expect(norm(moving.bearing)).toBeCloseTo(norm(expectedBearing), 0);

  // Tile data has arrived, so the collision world is real: the road spawn is
  // clear, while the inside of a building footprint blocks the car.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
          let count = 0;
          for (const list of [...map.tiles.values()].map(
            (t) => t.objects.buildings,
          )) {
            count += (list as unknown[]).length;
          }
          return count;
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const collision = await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: MapDebug }).__coolMap;
    const spawn = map.driveState();
    let blocked: string | null = null;
    for (const list of [...map.tiles.values()].map(
      (t) => t.objects.buildings,
    )) {
      for (const b of list as any[]) {
        if (!b.bbox) continue;
        const lon = (b.bbox[0] + b.bbox[2]) / 2;
        const lat = (b.bbox[1] + b.bbox[3]) / 2;
        if (map.collisionAt(lon, lat, 0)) {
          blocked = b.id ?? "building";
          break;
        }
      }
      if (blocked) break;
    }
    return {
      spawn: map.collisionAt(spawn.lon, spawn.lat, spawn.heading),
      blocked,
    };
  });
  expect(collision.spawn).toBe(false);
  expect(collision.blocked).not.toBeNull();

  // Escape leaves; the map is interactive again and the car is hidden
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await probe(page)).state.active, { timeout: 10_000 })
    .toBe(false);
  const left = await probe(page);
  expect(left.carVisible).toBe(false);
  expect(left.dragPan).toBe(true);
  await expect(page.locator("#drive-button")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.locator("#drive-hud")).toBeHidden();
  expect(errors).toEqual([]);
});
