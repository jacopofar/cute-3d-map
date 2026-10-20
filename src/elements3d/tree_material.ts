import * as THREE from "three";

/*
 * Street trees sway in the wind. The trees are merged into one geometry per
 * tile, so animating them on the CPU would mean rebuilding (and re-uploading)
 * a tile's geometry every frame — far too expensive for a decorative touch.
 * Instead the shared Lambert material gets a small vertex-shader patch: one
 * uniform write per frame, no extra geometry, no extra draw calls.
 *
 * The patch only touches `transformed`, so normals, lighting, fog, tone mapping
 * and shadow casting all keep working as before. The shadow depth pass uses
 * its own material and does not sway: the shadow of a canopy stays a fraction
 * of a meter behind the canopy, which at these amplitudes is invisible unless
 * you look for it.
 */

/**
 * Wall-clock time in seconds, shared by every compiled copy of the material so
 * the render loop updates it once. Kept as a uniform object (not a number) so
 * onBeforeCompile can hand the same reference to the shader.
 */
export const treeSway: THREE.IUniform<number> = { value: 0 };

// Peak horizontal offset at the top of a canopy, in meters. Deliberately small:
// canopies are a few pixels wide at map zoom, and a bigger number reads as a
// storm rather than a breeze. At street zoom this is a couple of pixels of
// travel on a 3-m crown, which is about what a light wind does.
export const SWAY_AMPLITUDE = 0.18;

// Height ramp, in model space (Z is up): the trunk below this stays put, the
// crown above it moves. Trees are 3-5 m tall, so this covers the trunk and the
// lower canopy while leaving the silhouette to do the work.
const SWAY_BASE = 1.0;
const SWAY_SPAN = 2.4;

export const treeMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
});

treeMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = treeSway;
  shader.uniforms.uSwayAmplitude = { value: SWAY_AMPLITUDE };

  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      /* glsl */ `
      #include <common>
      uniform float uTime;
      uniform float uSwayAmplitude;
      `,
    )
    .replace(
      "#include <begin_vertex>",
      /* glsl */ `
      #include <begin_vertex>

      // weight by height: a tree is planted, only its canopy moves. Squaring the
      // ramp keeps the trunk-to-canopy junction from shearing visibly.
      float swayHeight = clamp((transformed.z - ${SWAY_BASE.toFixed(1)}) / ${SWAY_SPAN.toFixed(1)}, 0.0, 1.0);
      float swayWeight = swayHeight * swayHeight;

      // Phase from the tree's world position, so neighbouring trees a few meters
      // apart do not sway in lockstep. Two incommensurate frequencies make the
      // motion read as a gust rather than a metronome; the cross term gives it a
      // slight figure-eight instead of a flat back-and-forth.
      float swayPhase = transformed.x * 0.85 + transformed.y * 1.3;
      float gust = sin(uTime * 1.1 + swayPhase) + 0.45 * sin(uTime * 2.7 + swayPhase * 1.7);
      float cross = sin(uTime * 0.8 + swayPhase * 2.1);
      transformed.x += gust * swayWeight * uSwayAmplitude;
      transformed.y += cross * swayWeight * uSwayAmplitude * 0.55;
      `,
    );
};
