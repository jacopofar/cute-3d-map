import * as THREE from "three";

// bake a flat color into a vertex color attribute, so many geometries can be
// merged into a single mesh (one draw call per tile instead of one per feature)
export function applyVertexColor(
  geometry: THREE.BufferGeometry,
  color: THREE.Color,
) {
  const count = geometry.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}
