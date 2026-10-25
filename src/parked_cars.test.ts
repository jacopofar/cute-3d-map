import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { epsg4326toEpsg3857, toModelCoords } from "./projection";
import {
  diffParkedTiles,
  PARKED_CAR_MIN_ZOOM,
  ParkedCarLayer,
  type ParkedTile,
} from "./parked_cars";

const ORIGIN: [number, number] = [9.19, 45.46];
const ORIGIN_METERS = epsg4326toEpsg3857(ORIGIN);
const SCALE = Math.cos((2 * Math.PI * ORIGIN[1]) / 360);

function spotsAt(lon: number, lat: number, count = 1) {
  return Array.from({ length: count }, (_, i) => ({
    lon: lon + i * 1e-4,
    lat,
    heading: 0,
  }));
}

function tile(key: string, spots = spotsAt(9.19, 45.46)): ParkedTile {
  return { key, spots };
}

function layerMesh(
  scene: THREE.Scene,
  key: string,
  lod?: "near" | "far",
): THREE.InstancedMesh {
  const found = scene.children.find(
    (object) =>
      object.userData?.kind === "parked_car" &&
      object.userData.tile === key &&
      (lod === undefined || object.userData.lod === lod),
  );
  if (!found) throw new Error(`no parked-car mesh for tile ${key}`);
  return found as THREE.InstancedMesh;
}

function parkedCarMeshes(scene: THREE.Scene): THREE.InstancedMesh[] {
  return scene.children.filter(
    (object) => object.userData?.kind === "parked_car",
  ) as THREE.InstancedMesh[];
}

describe("diffParkedTiles", () => {
  it("reports added, kept and removed keys", () => {
    expect(
      diffParkedTiles(["1_1", "1_2", "2_2"], ["1_2", "2_2", "2_3"]),
    ).toEqual({
      added: ["2_3"],
      removed: ["1_1"],
      kept: ["1_2", "2_2"],
    });
  });

  it("reports nothing when the window did not move", () => {
    expect(diffParkedTiles(["1_1", "1_2"], ["1_1", "1_2"])).toEqual({
      added: [],
      removed: [],
      kept: ["1_1", "1_2"],
    });
  });

  it("drops everything when the window empties", () => {
    expect(diffParkedTiles(["1_1"], [])).toEqual({
      added: [],
      removed: ["1_1"],
      kept: [],
    });
  });
});

describe("ParkedCarLayer", () => {
  it("places one static instance per spot", () => {
    const scene = new THREE.Scene();
    const layer = new ParkedCarLayer(scene, 10);
    layer.setTiles([tile("1_1")], ORIGIN_METERS, SCALE);
    expect(layer.count).toBe(1);
    expect(layer.tileCount).toBe(1);
    const mesh = layerMesh(scene, "1_1");
    expect(mesh.count).toBe(1);
    const first = new THREE.Matrix4();
    mesh.getMatrixAt(0, first);
    // the first spot is the origin itself
    expect(first.elements[12]).toBeCloseTo(0, 4);
    expect(first.elements[13]).toBeCloseTo(0, 4);
    // and sits on the ground with the car body's half height
    expect(first.elements[14]).toBeCloseTo(0.5, 4);
  });

  it("gives each tile its own mesh and draw call", () => {
    const scene = new THREE.Scene();
    const layer = new ParkedCarLayer(scene, 10);
    layer.setTiles(
      [tile("1_1", spotsAt(9.19, 45.46, 2)), tile("1_2", spotsAt(9.2, 45.46))],
      ORIGIN_METERS,
      SCALE,
    );
    expect(layer.tileCount).toBe(2);
    expect(layer.count).toBe(3);
    // empty tiles cost no draw call
    layer.setTiles(
      [
        tile("1_1", spotsAt(9.19, 45.46, 2)),
        tile("1_2", spotsAt(9.2, 45.46)),
        tile("1_3", []),
      ],
      ORIGIN_METERS,
      SCALE,
    );
    expect(layer.tileCount).toBe(2);
    expect(parkedCarMeshes(scene)).toHaveLength(2);
  });

  it("truncates a tile to its instance capacity", () => {
    const scene = new THREE.Scene();
    const layer = new ParkedCarLayer(scene, 2);
    layer.setTiles(
      [tile("1_1", spotsAt(9.19, 45.46, 3))],
      ORIGIN_METERS,
      SCALE,
    );
    expect(layer.count).toBe(2);
    expect(layerMesh(scene, "1_1").count).toBe(2);
  });

  it("does not rebuild tiles that stayed with the same spots", () => {
    const scene = new THREE.Scene();
    const layer = new ParkedCarLayer(scene, 10);
    const first = tile("1_1", spotsAt(9.19, 45.46, 2));
    const second = tile("1_2", spotsAt(9.2, 45.46, 2));
    layer.setTiles([first, second], ORIGIN_METERS, SCALE);
    const meshBefore = layerMesh(scene, "1_1");
    expect(layer.rebuildCount).toBe(2);

    // one tile enters, both old ones stay: only the new one is built
    layer.setTiles(
      [first, second, tile("1_3", spotsAt(9.21, 45.46))],
      ORIGIN_METERS,
      SCALE,
    );
    expect(layer.rebuildCount).toBe(3);
    expect(layerMesh(scene, "1_1")).toBe(meshBefore);
    expect(layer.tileCount).toBe(3);
  });

  it("rebuilds a tile whose spot list changed", () => {
    const scene = new THREE.Scene();
    const layer = new ParkedCarLayer(scene, 10);
    const stable = tile("1_2", spotsAt(9.2, 45.46));
    layer.setTiles([tile("1_1"), stable], ORIGIN_METERS, SCALE);
    const stableMesh = layerMesh(scene, "1_2");
    const oldMesh = layerMesh(scene, "1_1");
    let disposed = false;
    oldMesh.addEventListener("dispose", () => (disposed = true));

    // a reloaded tile hands the layer a fresh array
    layer.setTiles(
      [tile("1_1", spotsAt(9.19, 45.46, 3)), stable],
      ORIGIN_METERS,
      SCALE,
    );

    expect(disposed).toBe(true);
    expect(layer.rebuildCount).toBe(3);
    expect(layerMesh(scene, "1_1")).not.toBe(oldMesh);
    expect(layerMesh(scene, "1_2")).toBe(stableMesh);
    expect(layer.count).toBe(4);
  });

  it("drops the tile that left the window and frees its instances", () => {
    const scene = new THREE.Scene();
    const layer = new ParkedCarLayer(scene, 10);
    layer.setTiles([tile("1_1"), tile("1_2")], ORIGIN_METERS, SCALE);
    const leaving = layerMesh(scene, "1_1");
    let disposed = false;
    leaving.addEventListener("dispose", () => (disposed = true));

    layer.setTiles([tile("1_2")], ORIGIN_METERS, SCALE);

    expect(disposed).toBe(true);
    expect(parkedCarMeshes(scene).map((m) => m.userData.tile)).toEqual(["1_2"]);
    expect(layer.tileCount).toBe(1);
  });

  it("rebuilds every tile after a projection-origin reset", () => {
    const scene = new THREE.Scene();
    const layer = new ParkedCarLayer(scene, 10);
    const spots = tile("1_1", spotsAt(9.19, 45.46, 2));
    layer.setTiles([spots], ORIGIN_METERS, SCALE);
    const before = layerMesh(scene, "1_1");

    const shiftedOrigin = epsg4326toEpsg3857([9.2, 45.46]);
    layer.setTiles([spots], shiftedOrigin, SCALE);

    // coordinates are relative to the origin, so the old matrices are unusable
    expect(layer.rebuildCount).toBe(2);
    const after = layerMesh(scene, "1_1");
    expect(after).not.toBe(before);
    const matrix = new THREE.Matrix4();
    after.getMatrixAt(0, matrix);
    // the spot is now ~780 m west of the new origin, not at it
    expect(matrix.elements[12]).toBeLessThan(-500);
    expect(layer.count).toBe(2);
  });

  it("bounds each rebuilt tile, so off-screen tiles can be culled", () => {
    const scene = new THREE.Scene();
    const layer = new ParkedCarLayer(scene, 10);
    const spots = spotsAt(9.19, 45.46, 3);
    layer.setTiles([tile("1_1", spots)], ORIGIN_METERS, SCALE);
    const mesh = layerMesh(scene, "1_1");
    expect(mesh.frustumCulled).toBe(true);
    expect(mesh.boundingSphere).not.toBeNull();
    const sphere = mesh.boundingSphere!;
    expect(sphere.isEmpty()).toBe(false);
    // the sphere follows the cars instead of sitting at the model origin
    expect(Math.abs(sphere.center.x)).toBeGreaterThan(0.01);
    expect(sphere.radius).toBeGreaterThan(0);
  });

  it("is hidden by setEnabled(false), including tiles added later", () => {
    const scene = new THREE.Scene();
    const layer = new ParkedCarLayer(scene, 4);
    layer.setTiles([tile("1_1")], ORIGIN_METERS, SCALE);
    layer.setEnabled(false);
    expect(layerMesh(scene, "1_1").visible).toBe(false);
    layer.setTiles([tile("1_1"), tile("1_2")], ORIGIN_METERS, SCALE);
    expect(layerMesh(scene, "1_2").visible).toBe(false);
    layer.setEnabled(true);
    expect(layerMesh(scene, "1_1").visible).toBe(true);
    expect(layerMesh(scene, "1_2").visible).toBe(true);
  });

  it("splits a tile into a detailed near bucket and a box far bucket", () => {
    const scene = new THREE.Scene();
    const layer = new ParkedCarLayer(scene, 10);
    // one car at the view center, one about 1.1 km north
    const spots = [
      { lon: 9.19, lat: 45.46, heading: 0 },
      { lon: 9.19, lat: 45.47, heading: 0 },
    ];
    layer.setTiles([tile("1_1", spots)], ORIGIN_METERS, SCALE, [0, 0]);

    const near = layerMesh(scene, "1_1", "near");
    const far = layerMesh(scene, "1_1", "far");
    expect(near.count).toBe(1);
    expect(far.count).toBe(1);
    expect(layer.count).toBe(2);
    expect(layer.tileCount).toBe(1);
    expect(layer.meshCount).toBe(2);
    // one detailed body (52) and one box (12)
    expect(layer.triangles).toBe(64);
    // the detailed body has no index and 52 triangles; the box has 12
    expect(near.geometry.index).toBeNull();
    expect(near.geometry.getAttribute("position").count / 3).toBe(52);
    expect(far.geometry.index!.count / 3).toBe(12);
    // the far body still has vertex colors for the shared material
    expect(far.geometry.getAttribute("color")).not.toBeUndefined();
  });

  it("reclassifies only after the view center moves a LOD step", () => {
    const scene = new THREE.Scene();
    const layer = new ParkedCarLayer(scene, 10);
    const spots = [
      { lon: 9.19, lat: 45.46, heading: 0 },
      { lon: 9.19, lat: 45.4664, heading: 0 }, // ~710 m north
    ];
    const t = tile("1_1", spots);
    layer.setTiles([t], ORIGIN_METERS, SCALE, [0, 0]);
    expect(layer.rebuildCount).toBe(1);
    expect(layerMesh(scene, "1_1", "far").count).toBe(1);

    // inside the same 250 m bucket: the split is left alone
    layer.setTiles([t], ORIGIN_METERS, SCALE, [0, 40]);
    expect(layer.rebuildCount).toBe(1);

    // move the view center onto the far car: it becomes near
    const farModel = toModelCoords(
      [spots[1].lon, spots[1].lat],
      ORIGIN_METERS,
      SCALE,
    );
    layer.setTiles([t], ORIGIN_METERS, SCALE, farModel);
    expect(layer.rebuildCount).toBe(2);
    expect(layerMesh(scene, "1_1", "near").count).toBe(1);
    expect(layerMesh(scene, "1_1", "far").count).toBe(1);
    expect(layer.count).toBe(2);

    // halfway between the two cars, both are within the detail radius, so the
    // far bucket disappears entirely
    layer.setTiles([t], ORIGIN_METERS, SCALE, [
      farModel[0] / 2,
      farModel[1] / 2,
    ]);
    expect(layer.rebuildCount).toBe(3);
    expect(layerMesh(scene, "1_1", "near").count).toBe(2);
    expect(layer.meshCount).toBe(1);
    expect(layer.count).toBe(2);
  });

  it("uses the same zoom gate as the building windows", () => {
    expect(PARKED_CAR_MIN_ZOOM).toBe(17);
  });
});
