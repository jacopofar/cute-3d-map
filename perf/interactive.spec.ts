import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/*
 * Interactive frame-time benchmark on the real GPU.
 *
 * Unlike `frame_times.spec.ts` (headless Chromium on SwiftShader), this runs the
 * installed Google Chrome headed with GPU rasterization, so the frame times are
 * what a user actually sees. It warms the scene up (tile burst, geometry merges,
 * shader compile, facade detail), then measures three phases — pan, tilt and
 * zoom — and writes the numbers to perf-results/latest-gpu.json.
 *
 * Run with `npm run bench:gpu`. Panning is large enough to cross the z15 tile
 * grid, and the zoom phase crosses the facade-detail threshold, so the phases
 * exercise tile load/unload as well as raw triangle throughput.
 */

const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };
const RESULT_FILE = join("perf-results", "latest-gpu.json");

// central Milan, at a zoom where the facade detail exists (it starts above 17)
const START = { lng: 9.1919, lat: 45.4641, zoom: 17.2, pitch: 30 };
const WARMUP_MS = 7000;
const SETTLE_MS = 3500;
const PHASE_MS = 5000;

// pan amplitude in degrees: ~6 km east-west and ~5.5 km north-south over a
// phase, comfortably more than the 3-tile render margin so tiles load and
// unload during the measurement instead of the whole set staying resident
const PAN_LNG = 0.08;
const PAN_LAT = 0.05;

test.setTimeout(240_000);

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
  tileFetches: number;
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

async function stats(page: import("@playwright/test").Page): Promise<Stats> {
  return page.evaluate(() => {
    const map = (window as unknown as { __coolMap: { stats(): Stats } })
      .__coolMap;
    return map.stats();
  });
}

async function installLongTaskObserver(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__long.push(entry.duration);
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      // longtask is Chromium-only; frame times still work without it
    }
  });
}

async function longTasks(page: import("@playwright/test").Page) {
  return page.evaluate(
    () => (window as unknown as { __long: number[] }).__long,
  );
}

// Drive the map each animation frame for `ms`. The time parameter runs 0..1.
// Pan and zoom sweep out, hold still (long enough for the app's 150 ms
// move-debounce to run its tile/detail pass), then come back, so the phase
// includes the load hitch instead of continuously resetting the debounce.
async function runMotion(
  page: import("@playwright/test").Page,
  kind: "warmup" | "pan" | "tilt" | "zoom",
  ms: number,
): Promise<number[]> {
  return page.evaluate(
    async ({ kind, ms, start, panLng, panLat }) => {
      const map = (window as unknown as { __coolMap: { map: any } }).__coolMap
        .map;
      (window as unknown as { __long: number[] }).__long = [];
      const ease = (u: number) => u * u * (3 - 2 * u);
      // 0 at the ends, 1 on the far leg: sweep out, hold, sweep back
      const outAndBack = (t: number) => {
        if (t < 0.35) return ease(t / 0.35);
        if (t < 0.7) return 1;
        return 1 - ease((t - 0.7) / 0.3);
      };
      let lastKey = "";
      const apply = (center: [number, number], pitch: number, zoom: number) => {
        // skip the jump when the target did not change, or the still frames of
        // the hold would keep resetting the app's debounce
        const key =
          `${center[0].toFixed(7)},${center[1].toFixed(7)},` +
          `${pitch.toFixed(4)},${zoom.toFixed(4)}`;
        if (key === lastKey) return;
        lastKey = key;
        map.jumpTo({ center, pitch, zoom });
      };
      return await new Promise<number[]>((resolve) => {
        const frames: number[] = [];
        const t0 = performance.now();
        let last = 0;
        const tick = (now: number) => {
          if (last > 0) frames.push(now - last);
          last = now;
          const t = Math.min(1, (now - t0) / ms);
          if (kind === "pan" || kind === "warmup") {
            const p = outAndBack(t);
            apply(
              [start.lng + panLng * p, start.lat + panLat * p],
              kind === "warmup" ? start.pitch + 20 * p : start.pitch,
              kind === "warmup" ? start.zoom + 0.3 * p : start.zoom,
            );
          } else if (kind === "tilt") {
            apply(
              [start.lng, start.lat],
              start.pitch + 30 * Math.sin(2 * Math.PI * t),
              start.zoom,
            );
          } else {
            const p = outAndBack(t);
            apply([start.lng, start.lat], start.pitch, start.zoom + 1.1 * p);
          }
          if (t < 1) requestAnimationFrame(tick);
          else resolve(frames);
        };
        requestAnimationFrame(tick);
      });
    },
    { kind, ms, start: START, panLng: PAN_LNG, panLat: PAN_LAT },
  );
}

function summarize(
  frames: number[],
  longTaskDurations: number[],
  tileFetches: number,
): Sample {
  const f = frames.filter((x) => x > 0).sort((a, b) => a - b);
  const q = (p: number) => f[Math.min(f.length - 1, Math.floor(f.length * p))];
  const round = (x: number) => Math.round(x * 10) / 10;
  const mean = f.length > 0 ? f.reduce((a, b) => a + b, 0) / f.length : 0;
  return {
    frames: f.length,
    fps: mean > 0 ? round(1000 / mean) : 0,
    p50: f.length > 0 ? round(q(0.5)) : 0,
    p90: f.length > 0 ? round(q(0.9)) : 0,
    p99: f.length > 0 ? round(q(0.99)) : 0,
    worst: f.length > 0 ? round(f[f.length - 1]) : 0,
    longTasks: longTaskDurations.length,
    longTaskMs: round(longTaskDurations.reduce((a, b) => a + b, 0)),
    tileFetches,
  };
}

test("interactive frame times on the real GPU (pan, tilt, zoom)", async ({
  page,
}) => {
  let tileFetches = 0;
  page.on("response", (response) => {
    if (/^\/tiles\/\d+\/\d+\.json$/.test(new URL(response.url()).pathname)) {
      tileFetches++;
    }
  });

  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await page.waitForFunction(() => "__coolMap" in window, null, {
    timeout: 20_000,
  });
  const renderer = await webglInfo(page);

  // wait for the initial tile burst, then move to the benchmark view
  await expect
    .poll(async () => (await stats(page)).tiles, { timeout: 20_000 })
    .toBeGreaterThan(0);
  await page.evaluate((start) => {
    const map = (window as unknown as { __coolMap: { map: any } }).__coolMap
      .map;
    map.jumpTo({
      center: [start.lng, start.lat],
      zoom: start.zoom,
      pitch: start.pitch,
    });
  }, START);
  await page.waitForTimeout(1500);

  await installLongTaskObserver(page);

  // warmup: a few seconds of motion so the tiles, merged meshes, shader
  // programs and facade detail are all resident before anything is measured
  await runMotion(page, "warmup", WARMUP_MS);
  await page.evaluate((start) => {
    const map = (window as unknown as { __coolMap: { map: any } }).__coolMap
      .map;
    map.jumpTo({
      center: [start.lng, start.lat],
      zoom: start.zoom,
      pitch: start.pitch,
    });
  }, START);
  await page.waitForTimeout(SETTLE_MS);

  const startup = await stats(page);

  const phases: Record<string, Sample> = {};
  const after: Record<string, Stats> = {};
  for (const kind of ["pan", "tilt", "zoom"] as const) {
    const before = tileFetches;
    const frames = await runMotion(page, kind, PHASE_MS);
    const durations = await longTasks(page);
    phases[kind] = summarize(frames, durations, tileFetches - before);
    after[kind] = await stats(page);
    // let the phase's tile loads, facade rebuild and the debounced shadow
    // update settle before measuring the next phase
    await page.waitForTimeout(5000);
  }

  const result = {
    when: new Date().toISOString(),
    renderer,
    viewport: "1280x800",
    start: START,
    warmupMs: WARMUP_MS,
    settleMs: SETTLE_MS,
    phaseMs: PHASE_MS,
    startup,
    phases,
    after,
  };

  mkdirSync(dirname(RESULT_FILE), { recursive: true });
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2) + "\n");

  console.log(
    "\n=== interactive GPU performance ===\n" + JSON.stringify(result, null, 2),
  );
  console.log(
    `\nrenderer: ${renderer}\n` +
      `startup: ${startup.tiles} tiles, ${startup.meshes} meshes, ` +
      `${startup.triangles} triangles in ${startup.drawCalls} draw calls\n` +
      ["pan", "tilt", "zoom"]
        .map(
          (kind) =>
            `${kind.padEnd(5)}: ${phases[kind].fps} fps ` +
            `(p50 ${phases[kind].p50} ms, p90 ${phases[kind].p90} ms, ` +
            `p99 ${phases[kind].p99} ms, ${phases[kind].tileFetches} tile ` +
            `fetches, ${phases[kind].longTaskMs} ms long tasks)`,
        )
        .join("\n") +
      "\n",
  );

  for (const kind of ["pan", "tilt", "zoom"]) {
    expect(phases[kind].frames).toBeGreaterThan(0);
    expect(phases[kind].fps).toBeGreaterThan(1);
  }
});
