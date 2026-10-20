import * as THREE from "three";

/*
 * A bloom pass for the custom Three.js layer.
 *
 * The night look is carried by additive window, lamp and signal sprites, but
 * they sit on the canvas as flat discs: no glass bleeds light onto the wall
 * next to it. MapLibre owns the framebuffer, so this cannot be a post-process
 * over the whole map: we render the 3D scene into our own target, blur only the
 * parts brighter than the threshold, and composite the result over whatever
 * MapLibre has already drawn this frame. The basemap, labels and the roofs stay
 * outside the pass and therefore stay crisp.
 *
 * The scene target is not the canvas: three (r186) applies neither tone mapping
 * nor the output color space when rendering into a non-XR render target, so it
 * holds raw linear HDR. The bright pass and the blur therefore run in linear,
 * and the composite applies three's ACES curve and the sRGB conversion itself,
 * after adding the glow. That is what makes the bloomed frame's colors match
 * the direct frame, apart from the halo.
 */

// The blur works on a quarter of the drawing buffer: enough that a lamp halo
// reads as a soft bleed rather than a second, bigger disc, and cheap enough to
// leave the frame budget alone on an integrated GPU.
const BLOOM_SCALE = 0.25;
// Spread the Gaussian over more than one quarter-res texel: a single pass with
// unit offsets reads as a hard ring under a lamp rather than a soft bleed. Kept
// tight (was 2.5) because a wide radius on a quarter-res buffer turns every
// lamp into a large disc at 1280x800.
const BLUR_RADIUS = 1.4;
const BLUR_DIRECTION = new THREE.Vector2();

export interface BloomTuning {
  // how much of the blurred bright pass is added back
  strength: number;
  // luminance (linear HDR, before tone mapping) above which a pixel blooms
  threshold: number;
  // soft shoulder above the threshold, so a lamp does not switch on abruptly
  knee: number;
}

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Bright pass: keep the energy above the threshold, with a smooth shoulder.
const brightShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;
  void main() {
    vec3 color = texture2D(tDiffuse, vUv).rgb;
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    // a hard step would make a car headlight pop as it crosses the threshold
    float weight = smoothstep(uThreshold, uThreshold + uKnee, luma);
    gl_FragColor = vec4(color * weight, weight);
  }
`;

// Separable Gaussian, three taps per side (linear sampling halves the fetch
// count). Direction is set per pass; the taps are the usual 9-tap weights.
const blurShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uDirection;
  varying vec2 vUv;
  void main() {
    vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
    vec2 o1 = uDirection * 1.3846153846;
    vec2 o2 = uDirection * 3.2307692308;
    sum += texture2D(tDiffuse, vUv + o1).rgb * 0.3162162162;
    sum += texture2D(tDiffuse, vUv - o1).rgb * 0.3162162162;
    sum += texture2D(tDiffuse, vUv + o2).rgb * 0.0702702703;
    sum += texture2D(tDiffuse, vUv - o2).rgb * 0.0702702703;
    gl_FragColor = vec4(sum, 1.0);
  }
`;

// Composite the sharp scene over the blurred highlight and write over
// MapLibre's framebuffer. The scene target clears to alpha 0, so the blend is
// premultiplied: transparent sky leaves the basemap untouched, a lit window
// covers it, and the halo spreads into the transparent pixels around a lamp.
//
// three applies neither tone mapping nor the output color space when rendering
// into a render target (r186 forces non-XR targets to linear), so the scene
// comes out as raw linear HDR. Doing ACES here, on the scene plus the bloom,
// and sRGB-encoding at the very end is also what makes the frame match the
// direct render exactly when the strength is zero. The ACES curve is copied
// from three's tonemapping_pars_fragment so the two paths cannot drift apart.
const compositeShader = /* glsl */ `
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform float uStrength;
  uniform float uBloomScale;
  uniform float uExposure;
  varying vec2 vUv;

  vec3 RRTAndODTFit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }

  vec3 acesFilmic(vec3 color) {
    const mat3 inputMat = mat3(
      vec3(0.59719, 0.07600, 0.02840),
      vec3(0.35458, 0.90834, 0.13383),
      vec3(0.04823, 0.01566, 0.83777)
    );
    const mat3 outputMat = mat3(
      vec3( 1.60475, -0.10208, -0.00327),
      vec3(-0.53108,  1.10813, -0.07276),
      vec3(-0.07367, -0.00605,  1.07602)
    );
    color *= uExposure / 0.6;
    color = inputMat * color;
    color = RRTAndODTFit(color);
    color = outputMat * color;
    return clamp(color, 0.0, 1.0);
  }

  vec3 linearToSRGB(vec3 c) {
    c = max(c, vec3(0.0));
    vec3 low = c * 12.92;
    vec3 high = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
    return mix(high, low, step(c, vec3(0.0031308)));
  }

  void main() {
    vec4 scene = texture2D(tScene, vUv);
    vec3 bloom = texture2D(tBloom, vUv).rgb * uStrength;
    float bloomLuma = dot(bloom, vec3(0.2126, 0.7152, 0.0722));
    vec3 color = scene.rgb * scene.a + bloom;
    // the halo is its own cover: without this it would only show where the
    // scene already drew something, which is exactly where it is not needed
    float alpha = clamp(max(scene.a, bloomLuma * uBloomScale), 0.0, 1.0);
    gl_FragColor = vec4(linearToSRGB(acesFilmic(color)), alpha);
  }
`;

export class BloomPass {
  private renderer: THREE.WebGLRenderer;
  private sceneTarget?: THREE.WebGLRenderTarget;
  private brightTarget?: THREE.WebGLRenderTarget;
  private blurTargetA?: THREE.WebGLRenderTarget;
  private blurTargetB?: THREE.WebGLRenderTarget;
  private width = 0;
  private height = 0;
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private brightMaterial: THREE.ShaderMaterial;
  private blurMaterial: THREE.ShaderMaterial;
  private compositeMaterial: THREE.ShaderMaterial;
  readonly tuning: BloomTuning = {
    strength: 1.0,
    threshold: 0.4,
    knee: 0.3,
  };

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.brightMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uThreshold: { value: this.tuning.threshold },
        uKnee: { value: this.tuning.knee },
      },
      vertexShader,
      fragmentShader: brightShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.blurMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uDirection: { value: new THREE.Vector2() },
      },
      vertexShader,
      fragmentShader: blurShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        uStrength: { value: this.tuning.strength },
        uBloomScale: { value: 1.0 },
        uExposure: { value: renderer.toneMappingExposure },
      },
      vertexShader,
      fragmentShader: compositeShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      transparent: true,
      // premultiplied output: scene.rgb * scene.a + bloom, so a transparent
      // sky stays transparent without dimming the scene where alpha dips
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), [
      this.brightMaterial,
    ]);
    // the shared geometry is drawn once per pass with a different material;
    // three's scene would hide the mesh after the first render otherwise
    quad.frustumCulled = false;
    this.quad = quad;
    this.quadScene.add(quad);
  }

  private quad: THREE.Mesh;

  private disposeTargets(): void {
    this.sceneTarget?.dispose();
    this.brightTarget?.dispose();
    this.blurTargetA?.dispose();
    this.blurTargetB?.dispose();
    this.sceneTarget = undefined;
    this.brightTarget = undefined;
    this.blurTargetA = undefined;
    this.blurTargetB = undefined;
  }

  // (Re)allocate on a canvas resize. The scene target is full resolution: at
  // half size the whole frame, roofs included, would come back soft, which is
  // the opposite of what the pass is for.
  private ensureTargets(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.disposeTargets();
    const samples = Math.min(4, this.renderer.capabilities.maxSamples ?? 0);
    this.sceneTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples,
    });
    const bloomWidth = Math.max(1, Math.round(width * BLOOM_SCALE));
    const bloomHeight = Math.max(1, Math.round(height * BLOOM_SCALE));
    const bloomOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.brightTarget = new THREE.WebGLRenderTarget(
      bloomWidth,
      bloomHeight,
      bloomOptions,
    );
    this.blurTargetA = new THREE.WebGLRenderTarget(
      bloomWidth,
      bloomHeight,
      bloomOptions,
    );
    this.blurTargetB = new THREE.WebGLRenderTarget(
      bloomWidth,
      bloomHeight,
      bloomOptions,
    );
    this.width = width;
    this.height = height;
  }

  private drawPass(
    material: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget,
  ): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /*
   * Render the scene through the bloom chain into MapLibre's framebuffer.
   * Returns false (and draws nothing) if the targets could not be allocated, so
   * the caller can fall back to a direct render.
   */
  render(scene: THREE.Scene, camera: THREE.Camera): boolean {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (size.x < 2 || size.y < 2) return false;
    try {
      this.ensureTargets(size.x, size.y);
    } catch {
      this.disposeTargets();
      return false;
    }
    if (
      !this.sceneTarget ||
      !this.brightTarget ||
      !this.blurTargetA ||
      !this.blurTargetB
    ) {
      return false;
    }

    const previousTarget = this.renderer.getRenderTarget();
    const previousAutoClear = this.renderer.autoClear;
    const previousClearColor = this.renderer.getClearColor(new THREE.Color());
    const previousClearAlpha = this.renderer.getClearAlpha();
    const previousViewport = this.renderer.getViewport(new THREE.Vector4());
    const previousScissor = this.renderer.getScissor(new THREE.Vector4());
    const previousScissorTest = this.renderer.getScissorTest();

    this.renderer.autoClear = false;
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, size.x, size.y);
    this.renderer.setClearColor(0x000000, 0);

    // 1. the scene, at full resolution, with depth. autoClear is off for the
    // shared renderer, so clear by hand: a stale frame would smear into the
    // bloom on every camera move.
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.clear(true, true, true);
    this.renderer.render(scene, camera);

    // 2. bright pass into the quarter-size target
    this.brightMaterial.uniforms.tDiffuse.value = this.sceneTarget.texture;
    this.brightMaterial.uniforms.uThreshold.value = this.tuning.threshold;
    this.brightMaterial.uniforms.uKnee.value = this.tuning.knee;
    this.drawPass(this.brightMaterial, this.brightTarget);

    // 3. separable blur, ping-pong around the bright target
    this.blurMaterial.uniforms.tDiffuse.value = this.brightTarget.texture;
    BLUR_DIRECTION.set(BLUR_RADIUS / this.brightTarget.width, 0);
    this.blurMaterial.uniforms.uDirection.value.copy(BLUR_DIRECTION);
    this.drawPass(this.blurMaterial, this.blurTargetA);

    this.blurMaterial.uniforms.tDiffuse.value = this.blurTargetA.texture;
    BLUR_DIRECTION.set(0, BLUR_RADIUS / this.blurTargetA.height);
    this.blurMaterial.uniforms.uDirection.value.copy(BLUR_DIRECTION);
    this.drawPass(this.blurMaterial, this.blurTargetB);

    // 4. composite over MapLibre's framebuffer. setRenderTarget(null) binds the
    // canvas' default framebuffer, which is where MapLibre drew the basemap:
    // this is the step that would show a black frame if an external context
    // disagreed, hence the visual check in the report.
    this.renderer.setRenderTarget(previousTarget);
    this.renderer.setViewport(0, 0, size.x, size.y);
    this.compositeMaterial.uniforms.tScene.value = this.sceneTarget.texture;
    this.compositeMaterial.uniforms.tBloom.value = this.blurTargetB.texture;
    this.compositeMaterial.uniforms.uStrength.value = this.tuning.strength;
    this.compositeMaterial.uniforms.uExposure.value =
      this.renderer.toneMappingExposure;
    this.quad.material = this.compositeMaterial;
    // no clear here: the point of the composite is to lay the scene over the
    // basemap MapLibre already drew into this framebuffer
    this.renderer.render(this.quadScene, this.quadCamera);

    // 5. hand the context back the way MapLibre expects it
    this.renderer.setRenderTarget(previousTarget);
    this.renderer.setViewport(previousViewport);
    this.renderer.setScissor(previousScissor);
    this.renderer.setScissorTest(previousScissorTest);
    this.renderer.setClearColor(previousClearColor, previousClearAlpha);
    this.renderer.autoClear = previousAutoClear;
    return true;
  }

  dispose(): void {
    this.disposeTargets();
    this.brightMaterial.dispose();
    this.blurMaterial.dispose();
    this.compositeMaterial.dispose();
    this.quad.geometry.dispose();
  }
}
