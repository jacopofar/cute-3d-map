import { describe, expect, it } from "vitest";

import {
  DAY_HOUR,
  NIGHT_HOUR,
  currentMilanSolarHour,
  lerpColor,
  lightingAt,
  sunDirection,
} from "./daynight";

// The model follows the real date, so the tests pin a summer and a winter day.
const SUMMER = new Date("2026-06-21T12:00:00Z");
const WINTER = new Date("2026-12-21T12:00:00Z");

describe("lightingAt", () => {
  it("is brightest at solar noon and dimmest at solar midnight", () => {
    // overall brightness: the key light plus the ambient lights. The key alone
    // can dip at dusk, but the whole scene is never darker than at midnight.
    const brightness = (hour: number) => {
      const l = lightingAt(hour, SUMMER);
      return l.keyIntensity + l.hemisphereIntensity + l.fillIntensity;
    };
    const noon = brightness(12);
    const midnight = brightness(0);
    for (let hour = 0; hour < 24; hour += 0.25) {
      expect(brightness(hour)).toBeLessThanOrEqual(noon + 1e-9);
      expect(brightness(hour)).toBeGreaterThanOrEqual(midnight - 1e-9);
    }
    // and the key light itself peaks at solar noon
    expect(lightingAt(12, SUMMER).keyIntensity).toBeGreaterThan(
      lightingAt(0, SUMMER).keyIntensity,
    );
  });

  it("follows the season: the summer noon sun is higher than the winter one", () => {
    expect(lightingAt(12, SUMMER).keyDirection[2]).toBeGreaterThan(
      lightingAt(12, WINTER).keyDirection[2],
    );
  });

  it("puts the sun highest at solar noon", () => {
    const noon = lightingAt(12, SUMMER).keyDirection[2];
    for (const hour of [6, 8, 16, 18]) {
      expect(lightingAt(hour, SUMMER).keyDirection[2]).toBeLessThan(noon);
    }
  });

  it("always returns a unit key direction that never shines up from below", () => {
    for (let hour = 0; hour < 24; hour += 0.5) {
      for (const date of [SUMMER, WINTER]) {
        const [x, y, z] = lightingAt(hour, date).keyDirection;
        expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
        // the night is a moon, not a sun under the ground
        expect(z).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("warms the sun toward the horizon and cools it at night", () => {
    // red minus blue, a crude warmth measure
    const warmth = (hour: number, date: Date) => {
      const c = lightingAt(hour, date).keyColor;
      return ((c >> 16) & 255) - (c & 255);
    };
    // the low winter noon sun is warmer than the high summer one
    expect(warmth(12, WINTER)).toBeGreaterThan(warmth(12, SUMMER));
    // the moon is cooler (bluer) than the noon sun
    expect(warmth(0, SUMMER)).toBeLessThan(warmth(12, SUMMER));
  });

  it("blends 0 for night in bright day and 1 deep at night", () => {
    expect(lightingAt(12, SUMMER).night).toBe(0);
    expect(lightingAt(0, SUMMER).night).toBe(1);
    expect(lightingAt(3, SUMMER).night).toBe(1);
    expect(lightingAt(22, SUMMER).night).toBe(1);
  });

  it("wraps hours outside 0..24", () => {
    expect(lightingAt(25, SUMMER).keyIntensity).toBeCloseTo(
      lightingAt(1, SUMMER).keyIntensity,
      9,
    );
    expect(lightingAt(-1, SUMMER).night).toBeCloseTo(
      lightingAt(23, SUMMER).night,
      9,
    );
  });

  it("exposes the day and night presets as different states", () => {
    expect(lightingAt(DAY_HOUR, SUMMER).night).toBe(0);
    expect(lightingAt(NIGHT_HOUR, SUMMER).night).toBe(1);
  });
});

describe("sunDirection", () => {
  it("keeps the equinox sun on the horizon at 06:00 and 18:00", () => {
    const EQUINOX = new Date("2026-03-20T12:00:00Z");
    const sunrise = sunDirection(6, EQUINOX);
    const sunset = sunDirection(18, EQUINOX);
    expect(Math.abs(sunrise[2])).toBeLessThan(0.05);
    expect(Math.abs(sunset[2])).toBeLessThan(0.05);
    // rises in the east, sets in the west
    expect(sunrise[0]).toBeGreaterThan(0.9);
    expect(sunset[0]).toBeLessThan(-0.9);
    // at solar noon the sun is due south (north is negative) and high
    const noon = sunDirection(12, EQUINOX);
    expect(noon[1]).toBeLessThan(-0.6);
    expect(noon[2]).toBeGreaterThan(0.6);
  });
});

describe("currentMilanSolarHour", () => {
  it("adds Milan's longitude offset to UTC", () => {
    // 9.19 E is +36.76 minutes of solar time
    expect(currentMilanSolarHour(new Date("2026-06-21T12:00:00Z"))).toBeCloseTo(
      12.613,
      2,
    );
    // and wraps at midnight
    expect(currentMilanSolarHour(new Date("2026-06-21T23:40:00Z"))).toBeCloseTo(
      0.279,
      2,
    );
  });
});

describe("lerpColor", () => {
  it("interpolates each channel", () => {
    expect(lerpColor(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(lerpColor(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(lerpColor(0xff0000, 0x00ff00, 0.5)).toBe(0x808000);
  });
});
