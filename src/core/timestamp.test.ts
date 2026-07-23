import { describe, expect, it } from "vitest";
import { fixedClock } from "./clock.js";
import { isoTimestampSchema, nowIso } from "./timestamp.js";

describe("isoTimestampSchema", () => {
  it("accepts millisecond-precision UTC timestamps (Date#toISOString shape)", () => {
    expect(isoTimestampSchema.safeParse("2026-07-23T10:00:00.000Z").success).toBe(true);
  });

  it("accepts second-precision UTC timestamps (no fractional seconds)", () => {
    expect(isoTimestampSchema.safeParse("2026-07-23T10:00:00Z").success).toBe(true);
  });

  it("rejects a timestamp with no timezone marker at all", () => {
    expect(isoTimestampSchema.safeParse("2026-07-23T10:00:00").success).toBe(false);
  });

  it("rejects a timestamp with a numeric UTC offset instead of Z", () => {
    expect(isoTimestampSchema.safeParse("2026-07-23T10:00:00+01:00").success).toBe(false);
  });

  it("rejects a bare date with no time component", () => {
    expect(isoTimestampSchema.safeParse("2026-07-23").success).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isoTimestampSchema.safeParse("not a timestamp").success).toBe(false);
    expect(isoTimestampSchema.safeParse("").success).toBe(false);
  });
});

describe("nowIso", () => {
  it("reads the injected clock, not the real wall clock", () => {
    const clock = fixedClock(new Date("2026-01-01T12:34:56.789Z"));
    expect(nowIso(clock)).toBe("2026-01-01T12:34:56.789Z");
  });

  it("always produces a value the schema accepts", () => {
    const clock = fixedClock(new Date());
    expect(isoTimestampSchema.safeParse(nowIso(clock)).success).toBe(true);
  });
});
