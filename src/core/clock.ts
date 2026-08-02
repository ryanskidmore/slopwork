/**
 * Clock seam.
 *
 * design.md §8.1 item 5 requires ISO-8601 UTC timestamps everywhere, and
 * C5 (staleness) is explicitly acceptance-tested via "clock-injected
 * tests". Neither is possible if callers sprinkle `new Date()` /
 * `Date.now()` through the codebase. The rule: nothing outside this
 * module calls those directly — every function that needs "now" takes a
 * {@link Clock} parameter instead, so tests can inject a fixed one and
 * production code injects {@link systemClock}.
 */
export interface Clock {
  now(): Date;
}

/** The real clock. Used everywhere outside tests. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * A deterministic clock for tests. Starts at `initial` and only moves when
 * `set`/`advance` is called explicitly — never on its own.
 */
export interface TestClock extends Clock {
  set(date: Date): void;
  advance(ms: number): void;
}

export function fixedClock(initial: Date): TestClock {
  let current = initial;
  return {
    now: () => current,
    set(date: Date) {
      current = date;
    },
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

/**
 * The ONE env var every clock-injecting command honors for a fake "now" —
 * `SLOP_FAKE_NOW` (G5, t-uy8vo: `status`/`ready`/`web` used to each carry
 * their own identically-shaped, differently-named override —
 * `SLOP_STATUS_FAKE_NOW`/`SLOP_READY_FAKE_NOW`/`SLOP_WEB_FAKE_NOW` —
 * consolidated into this one, honored everywhere a clock is injected).
 * Read only here — test-only, never documented as a user-facing flag, and
 * absent in every real invocation, so real usage always gets
 * {@link systemClock}. When set to a parseable date, pins the clock
 * instead; unset or unparseable falls back to {@link systemClock} the
 * same way.
 */
export function resolveFakeClock(): Clock {
  const raw = process.env.SLOP_FAKE_NOW;
  if (!raw) return systemClock;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return systemClock;
  return fixedClock(parsed);
}
