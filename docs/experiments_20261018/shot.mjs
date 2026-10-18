// Standalone Playwright screenshot helper for the threejs_map repo.
// Usage:
//   node /tmp/opencode/shot.mjs <out.png> [hash] [waitMs] [realdark]
// hash example: "18/45.4641/9.1919"  (zoom/lat/lon)
// Set USE_MOCK_STYLE=1 to answer MapTiler with an empty style (no basemap).
import { createRequire } from "module";
const require = createRequire(
  "/home/jacopo/projects/threejs_map/package.json",
);
const { chromium } = require("playwright");

const out = process.argv[2] ?? "/tmp/opencode/shot.png";
const hash = process.argv[3] ?? "18/45.4641/9.1919";
const waitMs = Number(process.argv[4] ?? 9000);
const mockStyle = process.env.USE_MOCK_STYLE === "1";
const EMPTY_STYLE = { version: 8, sources: {}, layers: [] };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE ERROR:", m.text());
});
if (mockStyle) {
  await page.route("https://api.maptiler.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_STYLE),
    }),
  );
}
await page.goto(`http://localhost:5173/#map=${hash}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => "__coolMap" in window, null, {
  timeout: 20000,
});
// let tiles load and the scene settle
await page.waitForTimeout(waitMs);
const stats = await page.evaluate(() => {
  const m = window.__coolMap;
  return m?.stats ? m.stats() : "no stats";
});
console.log("STATS:", JSON.stringify(stats));
await page.screenshot({ path: out });
console.log("wrote", out);
await browser.close();
