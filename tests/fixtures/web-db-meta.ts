/**
 * Shared constant between the fixture generator
 * (tests/fixtures/generate-web-db.ts) and the D5 acceptance test
 * (tests/acceptance/D5.test.ts): the fictional "now" every fixture
 * timestamp is generated relative to.
 *
 * The committed fixture files carry fixed, absolute ISO timestamps (they
 * have to — they're static files). Staleness (design.md §2) is a function
 * of "now" versus `last_activity_at`, so if the server used the real
 * system clock, a ticket authored as "fresh" today would silently become
 * "stale" the day after, and the D5 test suite would start failing for a
 * reason that has nothing to do with a regression. `createWebServer`
 * therefore accepts an injectable {@link Clock} (src/core/clock.ts — the
 * same seam C5 uses for exactly this reason), and the test suite pins it
 * to this timestamp so every fixture ticket's fresh/stale status is
 * deterministic forever. The real `slop web` CLI command uses the system
 * clock, as it must.
 */
export const FIXTURE_NOW_ISO = "2026-07-23T12:00:00.000Z";
