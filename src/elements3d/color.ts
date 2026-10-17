import * as THREE from "three";

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL_COLOR = /^(?:rgb|rgba|hsl|hsla)\(/i;

// OSM color values are free text: they can be a semicolon list of two colors
// ("black;white"), carry spaces, or be a name THREE.Color does not know. Passing
// those straight to THREE.Color logs "Unknown color" and leaves the geometry
// white, so take the first entry and check it before trusting it. Used for both
// building and roof colors, which tilegen fills in when the tag is missing.
export function parseColor(
  value: string | undefined,
  fallback: string,
): THREE.Color {
  const candidate = value?.split(";")[0]?.trim();
  if (candidate) {
    const named = candidate.toLowerCase() in THREE.Color.NAMES;
    if (
      HEX_COLOR.test(candidate) ||
      FUNCTIONAL_COLOR.test(candidate) ||
      named
    ) {
      return new THREE.Color(candidate);
    }
  }
  return new THREE.Color(fallback);
}
