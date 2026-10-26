import { afterEach, describe, expect, it, vi } from "vitest";

import tilesPy from "../tilegen/tiles.py?raw";

import { BUILDER_CMTYPES, objectsAt } from "./geojson_data";

// A tile with one ordinary building and one degenerate cemetery: the sliver
// polygon (a real one, from Cimitero di Cormano) leaves no room for a row of
// graves, so the cemetery builder produces no geometry at all.
const TILE = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "way/1",
      properties: { cmtype: "building", height: 12, color: "#cccccc" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [9.1625, 45.5446],
            [9.1626, 45.5446],
            [9.1626, 45.5445],
            [9.1625, 45.5446],
          ],
        ],
      },
    },
    {
      type: "Feature",
      id: "way/93658825",
      properties: { cmtype: "cemetery", name: "Cimitero di Cormano" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [9.162528922518712, 45.54483149242463],
            [9.16259765625, 45.54483149242463],
            [9.16259765625, 45.54455464639861],
            [9.162528922518712, 45.54483149242463],
          ],
        ],
      },
    },
  ],
  traffic: [],
  parking: [],
  lamps: [],
};

function stubTile(body: unknown, contentType = "application/json") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: () => contentType },
      json: async () => body,
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("objectsAt", () => {
  it("keeps a tile whose layer built no geometry", async () => {
    stubTile(TILE);
    const objects = await objectsAt([9.1625, 45.5447], 17217, 11717, true);
    const kinds = objects.meshes.map((mesh) => mesh.userData.kind);
    // the empty cemetery group must not take the whole tile down with it
    expect(kinds).toContain("building");
    expect(kinds).not.toContain("cemetery");
  });

  it("treats a 404 as an empty tile", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 404,
        ok: false,
        headers: { get: () => "application/json" },
        json: async () => ({}),
      })),
    );
    const objects = await objectsAt([9.1625, 45.5447], 17217, 11717, true);
    expect(objects.meshes).toEqual([]);
    expect(objects.buildings).toEqual([]);
  });

  it("treats a dev-server HTML fallback as an empty tile", async () => {
    stubTile({}, "text/html");
    const objects = await objectsAt([9.1625, 45.5447], 17217, 11717, true);
    expect(objects.meshes).toEqual([]);
  });
});

describe("the tile contract", () => {
  // tilegen's tiles.py is the Python half of the same contract; this is the one
  // place the two lists are compared, so a new layer that is emitted but not
  // built (or built but no longer emitted) fails here instead of showing up as
  // a blank patch of map.
  const cmtypes = (): string[] => {
    // BY_CMTYPE is the contract's own index, so read that rather than the
    // per-shape Literals (some are quoted keys, some list two tags)
    const block = tilesPy.slice(tilesPy.indexOf("BY_CMTYPE"));
    return [...block.matchAll(/^ {4}"([a-z_]+)": \w+Properties,$/gm)].map(
      (match) => match[1],
    );
  };

  it("builds every cmtype tilegen emits", () => {
    // the two data-only stop points are read for the traffic slowdown and draw
    // nothing; see the traffic block in tilegen
    const dataOnly = new Set(["crossing", "traffic_signal"]);
    const unbuilt = cmtypes().filter(
      (cmtype) => !BUILDER_CMTYPES.includes(cmtype) && !dataOnly.has(cmtype),
    );
    expect(unbuilt).toEqual([]);
  });

  it("does not keep a builder for a cmtype tilegen stopped emitting", () => {
    const emitted = new Set(cmtypes());
    expect(BUILDER_CMTYPES.filter((cmtype) => !emitted.has(cmtype))).toEqual(
      [],
    );
  });
});
