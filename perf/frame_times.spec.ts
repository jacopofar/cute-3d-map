import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/*
 * Frame-time benchmark for the interactive map, so performance can be tracked
 * as features are added instead of being noticed only by feel.
 *
 * Run with `npm run bench`. It drives the real app in Chromium (same mocked
 * MapTiler style as the smoke tests, so it needs no network and no API key),
 * measures frame times while panning and while idle, and writes the numbers to
 * perf-results/latest.json. The assertions are deliberately loose sanity
 * bounds; the JSON is the thing to compare across commits.
 */

const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

// startup + idle + pan phases add up well past the default 30 s
test.setTimeout(180_000);

const RESULT_FILE = join("perf-results", "latest.json");

type Stats = {
  tiles: number;
  meshes: number;
  vertices: number;
  drawCalls: number;
  triangles: number;
  byKind: Record<
    string,
    { meshes: number; vertices: number; triangles: number }
  >;
  buildings: number;
  vehicles: number;
  trains: number;
};

type Sample = {
  frames: number;
  fps: number;
  p50: number;
  p90: number;
  p99: number;
  worst: number;
  longTasks: number;
  longTaskMs: number;
};

test.beforeEach(async ({ page }) => {
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
});

// starts an rAF sampler + long-task observer in the page
async function startSampling(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __frames: number[];
      __long: number[];
      __stop: boolean;
    };
    w.__frames = [];
    w.__long = [];
    w.__stop = false;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__long.push(entry.duration);
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      // longtask is Chromium-only; the frame times still work without it
    }
    let last = performance.now();
    const tick = () => {
      if (w.__stop) return;
      const now = performance.now();
      w.__frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopSampling(
  page: import("@playwright/test").Page,
  phase: string,
): Promise<Sample> {
  return page.evaluate((name) => {
    const w = window as unknown as {
      __frames: number[];
      __long: number[];
      __stop: boolean;
    };
    w.__stop = true;
    const f = w.__frames.filter((x) => x > 0).sort((a, b) => a - b);
    const q = (p: number) =>
      f[Math.min(f.length - 1, Math.floor(f.length * p))];
    const round = (x: number) => Math.round(x * 10) / 10;
    void name;
    return {
      frames: f.length,
      fps: round(1000 / (f.reduce((a, b) => a + b, 0) / f.length)),
      p50: round(q(0.5)),
      p90: round(q(0.9)),
      p99: round(q(0.99)),
      worst: round(f[f.length - 1]),
      longTasks: w.__long.length,
      longTaskMs: round(w.__long.reduce((a, b) => a + b, 0)),
    };
  }, phase);
}

async function stats(page: import("@playwright/test").Page): Promise<Stats> {
  return page.evaluate(() => {
    const map = (window as unknown as { __coolMap: { stats(): Stats } })
      .__coolMap;
    return map.stats();
  });
}

// what the frame times are measured against: a software rasterizer (headless,
// no GPU) makes the absolute numbers pessimistic but keeps them comparable
// between runs on the same machine
async function webglInfo(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const gl = document.querySelector("canvas")?.getContext("webgl2") as
      WebGL2RenderingContext | null | undefined;
    if (!gl) return "unknown";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
  });
}

test("frame times while panning and while idle", async ({ page }) => {
  const tileRequests: string[] = [];
  page.on("response", (r) => {
    const { pathname } = new URL(r.url());
    if (/^\/tiles\/\d+\/\d+\.json$/.test(pathname)) tileRequests.push(pathname);
  });

  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  const renderer = await webglInfo(page);

  // wait for the initial tile burst to settle
  await expect
    .poll(async () => (await stats(page)).tiles, { timeout: 20_000 })
    .toBeGreaterThan(0);
  await page.waitForTimeout(3000);

  const startup = await stats(page);
  const startupTiles = tileRequests.length;

  // idle: the fleets animate, so this is not "0 fps" — it is what the app
  // costs when the user does nothing
  await startSampling(page);
  await page.waitForTimeout(3000);
  const idle = await stopSampling(page, "idle");

  // pan: drag the pointer around for ~6 s, forcing tile load/unload churn
  tileRequests.length = 0;
  await startSampling(page);
  await page.mouse.move(640, 400);
  await page.mouse.down();
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(
      640 + Math.sin(i / 6) * 320,
      400 + Math.cos(i / 8) * 160,
      { steps: 2 },
    );
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  const pan = await stopSampling(page, "pan");
  await page.waitForTimeout(1500);
  const afterPan = await stats(page);

  const result = {
    when: new Date().toISOString(),
    renderer,
    startupTiles,
    panTileFetches: tileRequests.length,
    startup,
    afterPan,
    idle,
    pan,
  };

  mkdirSync(dirname(RESULT_FILE), { recursive: true });
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2) + "\n");

  console.log("\n=== map performance ===\n" + JSON.stringify(result, null, 2));
  console.log(
    `\nrenderer: ${renderer}\n` +
      `startup: ${startupTiles} tiles, ${startup.tiles} loaded, ` +
      `${startup.meshes} meshes, ${startup.triangles} triangles in ` +
      `${startup.drawCalls} draw calls\n` +
      `idle:    ${idle.fps} fps (p50 ${idle.p50} ms, ${idle.longTasks} long tasks)\n` +
      `pan:     ${pan.fps} fps (p50 ${pan.p50} ms, p90 ${pan.p90} ms, ` +
      `${pan.longTaskMs} ms of long tasks, ${tileRequests.length} tile fetches)\n` +
      `loaded geometry: ${JSON.stringify(startup.byKind)}\n`,
  );

  // Machine-independent gate: panning should cost little more than doing
  // nothing. The frame time while idle is this machine's floor (scene
  // rendering, mostly rasterizer bound), so comparing against it isolates the
  // per-move work (tile load/unload, vehicle graph rebuilds) that made panning
  // janky, regardless of how fast the GPU is.
  const jankRatio = Number(process.env.PERF_MAX_PAN_P90_RATIO ?? 2.5);
  expect(pan.p90).toBeLessThan(Math.max(50, idle.p90 * jankRatio));
  // absolute sanity bound for catastrophic regressions
  const maxIdleP50 = Number(process.env.PERF_MAX_IDLE_P50_MS ?? 250);
  expect(idle.p50).toBeLessThan(maxIdleP50);
});
