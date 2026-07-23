import { describe, expect, it } from "vitest";
import { fixedClock, systemClock } from "./clock.js";

describe("systemClock", () => {
  it("returns a Date close to the real current time", () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});

describe("fixedClock", () => {
  it("never moves on its own", () => {
    const initial = new Date("2026-01-01T00:00:00.000Z");
    const clock = fixedClock(initial);
    expect(clock.now()).toEqual(initial);
    expect(clock.now()).toEqual(initial);
  });

  it("set() jumps to an exact time", () => {
    const clock = fixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const later = new Date("2026-06-01T00:00:00.000Z");
    clock.set(later);
    expect(clock.now()).toEqual(later);
  });

  it("advance() moves forward by exactly the given number of milliseconds", () => {
    const clock = fixedClock(new Date("2026-01-01T00:00:00.000Z"));
    clock.advance(60_000);
    expect(clock.now()).toEqual(new Date("2026-01-01T00:01:00.000Z"));
    clock.advance(60_000);
    expect(clock.now()).toEqual(new Date("2026-01-01T00:02:00.000Z"));
  });
});
