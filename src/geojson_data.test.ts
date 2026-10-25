import { afterEach, describe, expect, it, vi } from "vitest";

import { objectsAt } from "./geojson_data";

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
