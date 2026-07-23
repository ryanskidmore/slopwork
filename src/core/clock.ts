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
