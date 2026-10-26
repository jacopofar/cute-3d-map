import { test, expect } from "@playwright/test";

import type { MapDebug } from "../src/debug";

// Same mocked style as the other specs.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };
test.setTimeout(120_000);

// Tunnel Giardini di Porta Nuova: a 220 m road underpass below the Biblioteca
// degli Alberi. Cars used to drive over the park above it.
const TUNNEL = "#map=17.2/45.48316/9.19255";

// The renderer's internals are private; this is the shape the spec reads. The
// invariant is what matters: no drawn instance whose loop time is inside one of
// its underground windows.
interface Fleet {
  now: () => number;
  slots: Int32Array;
  vehicles: {
    phase: number;
    period: number;
    hidden?: [number, number][];
  }[];
  mesh: {
    count: number;
    instanceMatrix: { array: ArrayLike<number> };
  };
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

test("a vehicle under a tunnel is not drawn, and its neighbours are", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/${TUNNEL}`);
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);

  const state = () =>
    page.evaluate(() => {
      const map = (window as unknown as { __coolMap: MapDebug }).__coolMap as
        (MapDebug & { carsTraffic?: Fleet }) | undefined;
      const fleet = map?.carsTraffic;
      if (!fleet)
        return {
          vehicles: 0,
          withWindows: 0,
          hiddenNow: 0,
          drawn: 0,
          leaked: 0,
        };
      const now = fleet.now();
      const tauOf = (vehicle: Fleet["vehicles"][number]) => {
        const tau = (now + vehicle.phase * vehicle.period) % vehicle.period;
        return tau < 0 ? tau + vehicle.period : tau;
      };
      const under = (vehicle: Fleet["vehicles"][number]) =>
        (vehicle.hidden ?? []).some(([start, end]) => {
          const tau = tauOf(vehicle);
          return tau >= start && tau < end;
        });
      const array = fleet.mesh.instanceMatrix.array;
      let drawn = 0;
      let leaked = 0;
      for (let i = 0; i < fleet.mesh.count; i++) {
        const offset = i * 16;
        // a hidden instance is a zero-scale matrix, so both scales read 0
        const zero =
          Math.abs(array[offset]) + Math.abs(array[offset + 5]) < 1e-9;
        if (zero) continue;
        drawn += 1;
        const vehicle = fleet.vehicles[fleet.slots[i]];
        if (vehicle && under(vehicle)) leaked += 1;
      }
      return {
        vehicles: fleet.vehicles.length,
        withWindows: fleet.vehicles.filter((v) => (v.hidden ?? []).length > 0)
          .length,
        hiddenNow: fleet.vehicles.filter(under).length,
        drawn,
        leaked,
      };
    });

  await expect
    .poll(async () => (await state()).withWindows, { timeout: 60_000 })
    .toBeGreaterThan(0);

  const seen = await state();
  // some route in view really is underground right now, and cars are drawn
  expect(seen.hiddenNow).toBeGreaterThan(0);
  expect(seen.drawn).toBeGreaterThan(0);

  // the placement slices catch up within a frame or two
  await expect
    .poll(async () => (await state()).leaked, { timeout: 10_000 })
    .toBe(0);

  expect(errors).toEqual([]);
});
