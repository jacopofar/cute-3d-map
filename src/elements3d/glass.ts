import * as THREE from "three";

/**
 * Raw tile properties, as `tilegen` writes them. The material tags are kept so
 * the classifier can also answer for hand-written GeoJSON that predates the
 * `glass` flag; after a regeneration every building carries the flag instead.
 */
export interface GlassTags {
  glass?: unknown;
  "building:material"?: string;
  "building:facade:material"?: string;
}

const MATERIAL_TAGS = ["building:material", "building:facade:material"] as const;

// the words tilegen keys on, kept in one place so the two ends cannot drift
const GLASS_WORDS = ["glass", "mirror"];

/**
 * Whether a building's facade is a curtain wall. A true `glass` property (what
 * tilegen reports) wins; otherwise look at the raw OSM material tags, whose
 * values may be `;` lists (`plaster;glass`).
 */
export function isGlass(props: GlassTags | undefined | null): boolean {
  if (!props) return false;
  if (props.glass === true) return true;
  return MATERIAL_TAGS.some((tag) => {
    const value = (props[tag] ?? "").toLowerCase();
    return GLASS_WORDS.some((word) => value.includes(word));
  });
}

// The tint of a curtain wall that OSM left colorless: a cool, faintly green
// blue, dark enough that the pane grid and the sky reflection read on it.
export const DEFAULT_GLASS_COLOR = "#5f7d86";

/**
 * The curtain-wall material. One ShaderMaterial for the whole glass kind: the
 * building's tile color is baked into its vertex colors, so the tone survives
 * the per-tile merge and a whole tile is still one draw call.
 *
 * Opaque on purpose: a transparent material would need per-feature sorting
 * against the city around it, and at this stylised scale a dark, reflective
 * pane reads better than a see-through one. What sells the glass is the pane
 * grid (model-space, so it is stable across origin resets and does not care
 * about the extrude geometry's own UVs) plus a fresnel sky term and a sharp sun
 * glint, the same key light the window shader uses.
 */
export const glassMaterial = new THREE.ShaderMaterial({
  vertexColors: true,
  uniforms: {
    uNight: { value: 0 },
    uKeyDirection: { value: new THREE.Vector3(0, -0.35, 1).normalize() },
    uKeyColor: { value: new THREE.Color(0xfff2df) },
    uKeyIntensity: { value: 2.4 },
    uAmbientColor: { value: new THREE.Color(0xcfe0ff) },
    uAmbientIntensity: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vColor;
    varying vec3 vNormal;
    varying vec3 vPosition;
    void main() {
      vColor = color;
      // no local transform on a tile mesh, so these are already model space
      vNormal = normal;
      vPosition = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uNight;
    uniform vec3 uKeyDirection;
    uniform vec3 uKeyColor;
    uniform float uKeyIntensity;
    uniform vec3 uAmbientColor;
    uniform float uAmbientIntensity;
    varying vec3 vColor;
    varying vec3 vNormal;
    varying vec3 vPosition;

    const float INV_PI = 0.3183099;
    // a floor is roughly 3.5 m, so a pane every 1.75 m lines up two per floor
    const float PANE = 1.75;
    // a floor is one pane tall, so the horizontal bands read as storeys
    const float FLOOR = 3.5;

    void main() {
      vec3 n = normalize(vNormal);
      float ndl = max(dot(n, uKeyDirection), 0.0);

      // pane grid from the model-space position: a wall seen from the side
      // tiles along its horizontal extent (y when it faces x, x otherwise) and
      // up its height. Floors and roofs are not curtain wall and get the x/y
      // grid, which they barely show anyway.
      float across = abs(n.z) > 0.5
        ? vPosition.x
        : (abs(n.x) > abs(n.y) ? vPosition.y : vPosition.x);
      vec2 cell = abs(fract(vec2(across, vPosition.z) / vec2(PANE, FLOOR)) - 0.5);
      float grid = smoothstep(0.42, 0.5, max(cell.x, cell.y));
      // Dark glass, not a white plaster tower: the tile color (often a pale
      // tagged blue) is pulled toward a deep blue-gray before the grid darkens
      // the mullions. Without this the lambert-plus-sky sum came out near
      // white after tone mapping.
      vec3 tint = mix(vColor, vec3(0.05, 0.10, 0.16), 0.75);
      vec3 pane = tint * mix(0.35, 0.75, grid);

      // fresnel towards the sky: at grazing angles the wall picks up the
      // hemisphere color, which is what separates glass from painted concrete
      vec3 view = normalize(cameraPosition - vPosition);
      float fresnel = pow(1.0 - max(dot(n, view), 0.0), 4.0);

      // much less light than a masonry wall: the base is dark and the sun
      // mostly shows up as a reflection, otherwise the tower blows out
      vec3 light =
        uAmbientColor * uAmbientIntensity * 0.35 +
        uKeyColor * uKeyIntensity * ndl * 0.20;
      vec3 day = pane * light * INV_PI;
      // the reflected sky is a shade of the ambient, brightened at grazing
      // angles; a low sun on the upper floors makes it read as mirror, but it
      // is kept low so the wall stays glass rather than a white slab
      day += uAmbientColor * (0.015 + 0.10 * fresnel);
      // a tight highlight: pow 64 keeps it a glint on the panes facing the sun
      // rather than a wash over the whole facade
      day += uKeyColor * pow(ndl, 64.0) * 0.25;

      // night: an unlit curtain wall goes near-black with a faint cool sky
      // reflection, so it does not disappear into the night
      vec3 night = pane * 0.08 + uAmbientColor * 0.05 * fresnel;
      gl_FragColor = vec4(mix(day, night, uNight), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
});
