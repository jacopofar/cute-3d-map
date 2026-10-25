import { test, expect } from "@playwright/test";

// Same trick as the other specs: a minimal valid style, so the map reaches
// "style.load" with no MapTiler key and no network.
const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

// tile parsing and SwiftShader are slow here, and the test reloads once at a
// feature coordinate so the projection origin is seeded there
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

const popupText = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      document.querySelector(".maplibregl-popup-content")?.innerText ?? null,
  );

test("benches, trees and park paths open their OSM popups", async ({
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

  // pick a bench in a park-like cluster: with a tree and a park path within
  // 60 m, the reload below can exercise a point, a line and an area in one view
  const benchHandle = await page.waitForFunction(
    () => {
      const map = (window as unknown as { __coolMap: any }).__coolMap;
      const seen = new Set<string>();
      const all: any[] = [];
      for (const list of [...map.tiles.values()].map(
        (t) => t.objects.features,
      )) {
        for (const f of list as any[]) {
          if (!f.id || seen.has(f.id)) continue;
          seen.add(f.id);
          all.push(f);
        }
      }
      const trees = all.filter((f) => f.kind === "tree" && f.lon !== undefined);
      const benches = all.filter(
        (f) => f.kind === "bench" && f.lon !== undefined,
      );
      const paths = all.filter((f) => f.kind === "park_path" && f.lines);
      const distance = (bench: any, lon: number, lat: number) => {
        const dx =
          (lon - bench.lon) * Math.cos((bench.lat * Math.PI) / 180) * 111_320;
        const dy = (lat - bench.lat) * 111_320;
        return Math.hypot(dx, dy);
      };
      let best: { bench: any; score: number } | null = null;
      for (const bench of benches) {
        let treesNear = 0;
        for (const tree of trees) {
          if (distance(bench, tree.lon, tree.lat) < 60) treesNear += 1;
        }
        let pathNear = false;
        for (const path of paths) {
          for (const line of path.lines as [number, number][][]) {
            for (const [lon, lat] of line) {
              if (distance(bench, lon, lat) < 60) pathNear = true;
            }
            if (pathNear) break;
          }
          if (pathNear) break;
        }
        const score = treesNear + (pathNear ? 100 : 0);
        if (!best || score > best.score) best = { bench, score };
      }
      return best ? best.bench : null;
    },
    { timeout: 45_000 },
  );
  const bench = (await benchHandle.jsonValue()) as {
    id: string;
    lon: number;
    lat: number;
  };

  // open the map on the bench. The query string forces a real navigation: a
  // hash-only goto is a same-document move, so the projection origin would keep
  // the old center and the tile meshes would not be rebuilt against the bench
  await page.goto(
    `/?pick=${encodeURIComponent(bench.id)}#map=19.5/${bench.lat}/${bench.lon}`,
  );
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => "__coolMap" in window).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true);
  await page.waitForFunction(
    (id) => {
      const map = (window as unknown as { __coolMap: any }).__coolMap;
      return [...map.tiles.values()]
        .map((t) => t.objects.features)
        .some((list) => (list as any[]).some((f) => f.id === id));
    },
    bench.id,
    { timeout: 45_000 },
  );
  // the trees are in the neighbouring tiles, which can still be in flight when
  // the bench's own tile lands: wait for one to be in view instead of guessing
  // with a fixed delay (the sweep below tries several of them anyway)
  await page.waitForFunction(
    () => {
      const map = (window as unknown as { __coolMap: any }).__coolMap;
      const container = map.map.getContainer() as HTMLElement;
      let inView = 0;
      for (const list of [...map.tiles.values()].map(
        (t) => t.objects.features,
      )) {
        for (const f of list as any[]) {
          if (f.kind !== "tree" || f.lon === undefined) continue;
          const p = map.map.project([f.lon, f.lat]);
          if (
            p.x > 100 &&
            p.y > 150 &&
            p.x < container.clientWidth - 100 &&
            p.y < container.clientHeight - 100
          ) {
            inView += 1;
          }
        }
      }
      return inView >= 1;
    },
    null,
    { timeout: 45_000 },
  );

  const canvas = await page.locator("canvas.maplibregl-canvas").boundingBox();
  const clickAt = async (x: number, y: number) => {
    await page.mouse.click(canvas!.x + x, canvas!.y + y);
    await page.waitForTimeout(250);
    return popupText(page);
  };

  // the bench is at the map center; the seat sits a few pixels above the point
  const benchPoint = await page.evaluate((id) => {
    const map = (window as unknown as { __coolMap: any }).__coolMap;
    for (const list of [...map.tiles.values()].map((t) => t.objects.features)) {
      for (const f of list as any[]) {
        if (f.id !== id || f.lon === undefined) continue;
        const p = map.map.project([f.lon, f.lat]);
        return { x: p.x, y: p.y };
      }
    }
    return null;
  }, bench.id);
  expect(benchPoint).not.toBeNull();

  let benchOk = false;
  for (const dy of [0, -2, -4, -6]) {
    const text = await clickAt(benchPoint!.x, benchPoint!.y + dy);
    if (text && /Bench/.test(text) && /OSM/.test(text)) {
      benchOk = true;
      break;
    }
  }
  expect(benchOk).toBe(true);

  // a tree's canopy is above its trunk point; sweep a few pixels up
  const trees = (await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: any }).__coolMap;
    const container = map.map.getContainer() as HTMLElement;
    const out: { id: string; x: number; y: number }[] = [];
    for (const list of [...map.tiles.values()].map((t) => t.objects.features)) {
      for (const f of list as any[]) {
        if (f.kind !== "tree" || f.lon === undefined) continue;
        const p = map.map.project([f.lon, f.lat]);
        if (
          p.x > 100 &&
          p.y > 150 &&
          p.x < container.clientWidth - 100 &&
          p.y < container.clientHeight - 100
        ) {
          out.push({ id: f.id, x: p.x, y: p.y });
        }
        if (out.length >= 8) break;
      }
      if (out.length >= 8) break;
    }
    return out;
  })) as { id: string; x: number; y: number }[];

  console.log(`DEBUG trees=${trees.length} ${JSON.stringify(trees)}`);
  let treeOk = false;
  for (const tree of trees) {
    for (const dy of [-12, -9, -6, -3, 0]) {
      const text = await clickAt(tree.x, tree.y + dy);
      console.log(`DEBUG click ${tree.id} dy=${dy} -> ${JSON.stringify(text)}`);
      if (text && /Tree|Conifer/.test(text) && /OSM/.test(text)) {
        treeOk = true;
        break;
      }
    }
    if (treeOk) break;
  }
  expect(treeOk).toBe(true);

  // a park path is a flat ribbon: its own vertex is a reliable click point
  const path = (await page.evaluate(() => {
    const map = (window as unknown as { __coolMap: any }).__coolMap;
    const container = map.map.getContainer() as HTMLElement;
    for (const list of [...map.tiles.values()].map((t) => t.objects.features)) {
      for (const f of list as any[]) {
        if (f.kind !== "park_path" || !f.lines) continue;
        for (const line of f.lines) {
          const p = map.map.project(line[Math.floor(line.length / 2)]);
          if (
            p.x > 100 &&
            p.y > 100 &&
            p.x < container.clientWidth - 100 &&
            p.y < container.clientHeight - 100
          ) {
            return { id: f.id, x: p.x, y: p.y };
          }
        }
      }
    }
    return null;
  })) as { id: string; x: number; y: number } | null;
  expect(path).not.toBeNull();

  let pathOk = false;
  for (const dy of [0, -2, 2]) {
    const text = await clickAt(path!.x, path!.y + dy);
    if (text && /Footpath|Cycle path/.test(text) && /OSM/.test(text)) {
      pathOk = true;
      break;
    }
  }
  expect(pathOk).toBe(true);

  expect(errors).toEqual([]);
});
