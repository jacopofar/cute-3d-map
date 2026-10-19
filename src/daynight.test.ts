import { describe, expect, it } from "vitest";

import { DAY_HOUR, NIGHT_HOUR, lerpColor, lightingAt } from "./daynight";

describe("lightingAt", () => {
  it("is brightest at noon and dimmest at midnight", () => {
    // overall brightness: the key light plus the ambient lights. The key alone
    // can dip at dusk, but the whole scene is never darker than at midnight.
    const brightness = (hour: number) => {
      const l = lightingAt(hour);
      return l.keyIntensity + l.hemisphereIntensity + l.fillIntensity;
    };
    const noon = brightness(12);
    const midnight = brightness(0);
    for (let hour = 0; hour < 24; hour += 0.25) {
      expect(brightness(hour)).toBeLessThanOrEqual(noon + 1e-9);
      expect(brightness(hour)).toBeGreaterThanOrEqual(midnight - 1e-9);
    }
    // and the key light itself peaks at noon
    expect(lightingAt(12).keyIntensity).toBeGreaterThan(
      lightingAt(0).keyIntensity,
    );
  });

  it("grows monotonically from dawn to noon and shrinks to dusk", () => {
    for (let hour = 6; hour < 12; hour += 0.25) {
      expect(lightingAt(hour + 0.25).keyIntensity).toBeGreaterThan(
        lightingAt(hour).keyIntensity,
      );
    }
    for (let hour = 12; hour < 18; hour += 0.25) {
      expect(lightingAt(hour + 0.25).keyIntensity).toBeLessThan(
        lightingAt(hour).keyIntensity,
      );
    }
  });

  it("puts the sun highest at noon", () => {
    const noon = lightingAt(12).keyDirection;
    expect(noon[2]).toBeGreaterThan(0.8); // mostly overhead
    for (const hour of [6, 8, 16, 18]) {
      expect(lightingAt(hour).keyDirection[2]).toBeLessThan(noon[2]);
    }
  });

  it("always returns a unit key direction", () => {
    for (let hour = 0; hour < 24; hour += 0.5) {
      const [x, y, z] = lightingAt(hour).keyDirection;
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
      // the key never shines up from below (the night is a moon, not a sun)
      expect(z).toBeGreaterThanOrEqual(0);
    }
  });

  it("warms the sun toward dawn and dusk and cools it at night", () => {
    // red minus blue, a crude warmth measure
    const warmth = (hour: number) => {
      const c = lightingAt(hour).keyColor;
      return ((c >> 16) & 255) - (c & 255);
    };
    expect(warmth(6.2)).toBeGreaterThan(warmth(12)); // horizon is warmer
    // the moon is cooler (bluer) than the noon sun
    expect(warmth(0)).toBeLessThan(warmth(12));
  });

  it("blends 0 for night in bright day and 1 deep at night", () => {
    expect(lightingAt(12).night).toBe(0);
    expect(lightingAt(0).night).toBe(1);
    expect(lightingAt(3).night).toBe(1);
    expect(lightingAt(22).night).toBe(1);
  });

  it("wraps hours outside 0..24", () => {
    expect(lightingAt(25).keyIntensity).toBeCloseTo(
      lightingAt(1).keyIntensity,
      9,
    );
    expect(lightingAt(-1).night).toBeCloseTo(lightingAt(23).night, 9);
  });

  it("exposes the day and night presets as different states", () => {
    expect(lightingAt(DAY_HOUR).night).toBe(0);
    expect(lightingAt(NIGHT_HOUR).night).toBe(1);
  });
});

describe("lerpColor", () => {
  it("interpolates each channel", () => {
    expect(lerpColor(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(lerpColor(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(lerpColor(0xff0000, 0x00ff00, 0.5)).toBe(0x808000);
  });
});
