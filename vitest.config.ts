import { defineConfig } from "vitest/config";

// Test layout convention (see README.md "Testing"):
//   - unit tests live beside the code as `*.test.ts` (e.g. src/core/foo.test.ts)
//   - acceptance tests live in tests/acceptance/<ITEM-ID>.test.ts, one file
//     per v0-implementation-plan.md §3 work item
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // A1's own acceptance test builds the compiled binary in beforeAll,
    // which is slower than a typical unit test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Hard sandbox backstop (see tests/support/repo-slop-guard.ts's own
    // doc comment): hashes this repo's own `.slop/` before the suite and
    // fails the whole run, naming offending files, if it's not
    // byte-for-byte identical after — this repo dogfoods itself, so
    // `.slop/` is a live database no test may ever touch.
    globalSetup: ["./tests/support/repo-slop-guard.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**"],
      // Coverage-instrumentation exclusions — kept to the SMALLEST honest
      // set: only modules verified to be genuinely un-loadable inside a
      // vitest worker, never anything that merely lacked a test before.
      // Verified directly (2026-07-24): a vitest worker process has NO
      // `Bun` global at all (`process.versions.bun`/`typeof Bun` are both
      // `undefined` even though `vitest` itself is launched via `bun run
      // test`, since Bun's script-runner still executes vitest's own
      // worker pool under real Node semantics) — so any module that
      // touches a Bun-only API at import time, or that imports an asset
      // via Bun's bundler-only `with { type: "text" }` attribute (which
      // vitest's transform does NOT understand — it was confirmed to throw
      // `ReferenceError: document is not defined` while trying to
      // literally execute assets/app.js as a script), cannot be imported
      // under vitest at all, let alone instrumented. Every module below
      // was confirmed to hit exactly one of those two failure modes.
      // Everything ELSE — including every `src/cli/commands/*` handler —
      // imports cleanly and is exercised for real by this suite's
      // in-process tests (see e.g. new.test.ts/status.test.ts/
      // start.test.ts's "runX (in-process)" describe blocks); none of that
      // is excluded, and it must never become excluded as a shortcut.
      exclude: [
        "src/**/*.test.ts",
        // rewrite-slop-web-as-a: the SPA. `src/web/frontend/**` is browser
        // code (React/TSX) that this suite cannot execute at all — vitest runs
        // under Bun with no DOM, and `slop web` is verified black-box over
        // HTTP instead (see the D5 entries in docs/DECISIONS.md).
        // `src/web/generated/**` is BUILD OUTPUT: the compiled ~500KB bundle
        // emitted by `bun run build:web`.
        //
        // Both must be excluded for two separate reasons. Correctness: v8's
        // provider crashes with a PARSE_ERROR trying to remap coverage for
        // them as "uncovered files". Meaningfulness: counting a half-megabyte
        // generated bundle as uncovered source dragged the reported totals to
        // ~20% functions/statements and failed every threshold — a number that
        // described the bundler's output, not this project's test coverage.
        "src/web/frontend/**",
        "src/web/generated/**",
        // Bundled/embedded browser-side assets — plain CSS/JS meant to run
        // in a browser, not Node/Bun-executed code at all. Imported into
        // server.ts only via Bun's `with { type: "text" }` text-loader
        // (see that file's own doc comment), which is itself excluded
        // below; exercised indirectly via web/*.test.ts's HTML-output
        // assertions against the served page, never instrumentable by v8
        // coverage of the vitest worker.
        "src/web/assets/**",
        "src/web/assets.d.ts",
        // `slop web`'s HTTP server: `Bun.serve(...)` at call time, plus a
        // module-top-level `import appJs from "./assets/app.js" with {
        // type: "text" }` that throws under vitest's transform (see this
        // block's header comment) — the import itself fails, before any
        // of this file's own logic could run, let alone be instrumented.
        // Covered by tests/acceptance/web-real-repo.test.ts and
        // packaging.test.ts, which spawn the real (or compiled) CLI and
        // hit the server over real HTTP.
        "src/web/server.ts",
        // `slop web`'s CLI wrapper — imports `../../web/index.js`, which
        // re-exports `startWebServer` from the now-excluded server.ts, so
        // it transitively fails to import under vitest the same way.
        // web.test.ts already covers this file's OWN pure logic (parsePort)
        // by testing it directly rather than through this exclusion; repo
        // root discovery itself is the shared `requireRepoRoot`
        // (src/repo/paths.ts, covered by its own unit tests), and the full
        // command is exercised via the same spawned acceptance suites as
        // server.ts above.
        "src/cli/commands/web.ts",
        // The root CLI entrypoint (`bin/slop.mjs`'s target, and `bun
        // build --compile`'s target for `dist/slop`) — imports
        // `./commands/index.js`, which imports `registerWebCommand` from
        // the now-excluded web.ts, so it transitively fails to import
        // under vitest too. This is by far the most heavily
        // subprocess-tested file in the repo: every acceptance test under
        // tests/acceptance/ spawns it (`bun src/cli/index.ts ...`), and
        // A1.test.ts/packaging.test.ts spawn the compiled `dist/slop`
        // binary built from it. argv.ts/errors.ts (its two real logic
        // modules) are unit-tested directly and are NOT excluded.
        "src/cli/index.ts",
        // Pure command-registration wiring (one `program.command(...)`
        // call per command, no logic of its own) — but it imports
        // `registerWebCommand` from the now-excluded web.ts too, so, same
        // as index.ts above, it transitively fails to import under
        // vitest. Every command it registers is imported and tested
        // directly by that command's own test file; this file's own
        // wiring is exercised every time any acceptance test spawns the
        // real CLI (which calls it on every single invocation).
        "src/cli/commands/index.ts",
      ],
      // Measured on 2026-07-24, AFTER the exclusions above and AFTER
      // adding in-process `run<Cmd>` tests for every src/cli/commands/*
      // handler (see e.g. new.test.ts/done.test.ts/start.test.ts/
      // status.test.ts's "(in-process)" describe blocks): ~84% statements
      // / ~74% branches / ~83% functions / ~86% lines overall — up from an
      // honest ~63%/~57%/~64%/~63% baseline (measured the same way, before
      // any of the exclusions or in-process tests below existed — only
      // `src/web/assets/**`/`assets.d.ts` were excluded then) where
      // src/cli/commands/** sat at ~3% not because it was untested (every
      // command already had an acceptance test under tests/acceptance/)
      // but because this project's established convention was to
      // exercise it ONLY as a genuine spawned subprocess, invisible to v8
      // coverage of the vitest worker process. That subprocess convention
      // is preserved (every existing spawned test file is untouched) —
      // what changed is ADDING a second, in-process layer alongside it:
      // every command's `run<Cmd>` function is now `export`ed and driven
      // directly against an isolated temp repo (tests/support/
      // cli-harness.ts's withCwd/bootstrapRepo/captureOutput), which is
      // real, honest v8 coverage of the actual command logic, not a
      // workaround. src/cli/commands/** itself now measures ~85/76/82/87.
      // `src/web/**` (views, data-source, fixture-data-source) is
      // deliberately NOT excluded beyond the four modules above — every
      // view module only imports Bun-only code by TYPE (`import type {
      // BunRequest } from "bun"`, erased at compile time), so it imports
      // cleanly under vitest and several already have direct unit tests
      // (review.ts/ticket-detail.ts); the remainder stays a real, honest
      // ~16% dragging src/web down rather than being excluded as a
      // shortcut — same treatment markdown.ts's Bun.markdown-dependent
      // half and fixture-data-source.ts's Bun.file-dependent bulk already
      // got. The global thresholds below are set a few points under the
      // measured ~84/74/83/86, purely to catch a regression; the
      // per-directory glob thresholds are unchanged (or raised) from
      // their own measured numbers, same convention as before, plus a new
      // `src/cli/commands/**` glob set a few points under ITS measured
      // ~85/76/82/87 — the thing this ticket's brief calls out as the
      // primary target.
      thresholds: {
        statements: 82,
        branches: 71,
        functions: 80,
        lines: 83,
        "src/core/**": { statements: 94, branches: 87, functions: 99, lines: 97 },
        "src/repo/**": { statements: 91, branches: 82, functions: 97, lines: 94 },
        "src/sessions/**": { statements: 92, branches: 84, functions: 95, lines: 94 },
        "src/tickets/**": { statements: 95, branches: 89, functions: 98, lines: 96 },
        "src/cli/commands/**": { statements: 78, branches: 68, functions: 76, lines: 80 },
      },
    },
  },
});
