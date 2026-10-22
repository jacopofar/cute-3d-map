#!/usr/bin/env node

/*
 * Run only the Playwright specs that a branch's diff can affect.
 *
 * The full e2e suite takes ~5 minutes because every spec boots the map and
 * loads the 49-tile window. During implementation, run this instead; keep the
 * full `npm run test:e2e` for a merge gate (and after tilegen changes, which can
 * affect every layer).
 *
 * Usage:
 *   node scripts/e2e-changed.mjs [--base <ref>] [--list]
 *   npm run test:e2e:changed -- --base main
 */

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const list = args.includes("--list");
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? args[baseIndex + 1] : "main";

function git(argv) {
  try {
    return execFileSync("git", argv, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const files = new Set();
for (const argv of [
  ["diff", "--name-only", `${base}...HEAD`],
  ["diff", "--name-only"],
  ["diff", "--cached", "--name-only"],
  ["ls-files", "--others", "--exclude-standard"],
]) {
  for (const line of git(argv).split("\n")) {
    if (line) files.add(line);
  }
}

const docs = [...files].every(
  (file) =>
    file.endsWith(".md") ||
    file.startsWith("docs/") ||
    file.startsWith("reports/") ||
    file === "ideas.md",
);
if (files.size > 0 && docs) {
  console.log("Only docs changed; skipping e2e.");
  process.exit(0);
}

// Each rule maps a changed file to the spec(s) that exercise it. A branch can
// match several rules; the union is run once.
const rules = [
  [/^e2e\/([a-z_]+)\.spec\.ts$/, (match) => [`e2e/${match[1]}.spec.ts`]],
  [/elements3d\/transit\.ts$/, () => ["e2e/transit.spec.ts"]],
  [/elements3d\/fountain\.ts$/, () => ["e2e/fountain.spec.ts"]],
  [/elements3d\/(furniture|box_builder)\.ts$/, () => ["e2e/furniture.spec.ts"]],
  [
    /elements3d\/(cemetery|tombstone_rows)\.ts$/,
    () => ["e2e/cemetery.spec.ts"],
  ],
  [/elements3d\/terrace\.ts$/, () => ["e2e/terrace.spec.ts"]],
  [
    /elements3d\/(playground|monument)\.ts$/,
    () => ["e2e/playground_monument.spec.ts"],
  ],
  [/elements3d\/construction\.ts$/, () => ["e2e/construction.spec.ts"]],
  [/elements3d\/crosswalk\.ts$/, () => ["e2e/crosswalk.spec.ts"]],
  [/elements3d\/road_marking\.ts$/, () => ["e2e/road_markings.spec.ts"]],
  [/elements3d\/(platform|rail)\.ts$/, () => ["e2e/transit_platforms.spec.ts"]],
  [
    /elements3d\/(facade|facade_layout|building|glass|roof|roof_layout)\.ts$/,
    () => ["e2e/facade.spec.ts"],
  ],
  [/parked_cars\.ts$|parking_layout\.ts$|traffic\.ts$/, () => ["e2e/parked_cars.spec.ts"]],
  [/elements3d\/water\.ts$/, () => ["e2e/water.spec.ts"]],
  [/elements3d\/green\.ts$/, () => ["e2e/green.spec.ts"]],
  [/elements3d\/bench\.ts$/, () => ["e2e/benches.spec.ts"]],
  [/elements3d\/church\.ts$/, () => ["e2e/church.spec.ts"]],
  [/night_lights\.ts$|tilegen\/lamps\.py$/, () => ["e2e/lampposts.spec.ts"]],
  [/airplanes?\.ts$|aeroway\.ts$/, () => ["e2e/airplanes.spec.ts"]],
  [
    /elements3d\/(bridge|bridge_layout|fence|tunnel)\.ts$/,
    () => ["e2e/layers.spec.ts"],
  ],
  [
    /^src\/(main|geojson_data)\.ts$|^index\.html$|map_style\.css$/,
    () => [
      "e2e/smoke.spec.ts",
      "e2e/layers.spec.ts",
      "e2e/permalink.spec.ts",
      "e2e/basemap.spec.ts",
    ],
  ],
];

const specs = new Set(["e2e/smoke.spec.ts"]);
let tilegen = false;
for (const file of files) {
  if (file.startsWith("tilegen/")) tilegen = true;
  for (const [pattern, resolve] of rules) {
    const match = file.match(pattern);
    if (!match) continue;
    for (const spec of resolve(match)) specs.add(spec);
  }
}

if (tilegen) {
  console.log(
    "tilegen changed: smoke will run, but run the full e2e before merging.",
  );
}
if (files.size === 0) {
  console.log(`No changes against ${base}; running the smoke spec.`);
}

const selected = [...specs];
console.log(`Running ${selected.length} spec(s): ${selected.join(" ")}`);
if (list) process.exit(0);

execFileSync("npx", ["playwright", "test", "--workers=2", ...selected], {
  stdio: "inherit",
});
