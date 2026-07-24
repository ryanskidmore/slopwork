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
      exclude: [
        "src/**/*.test.ts",
        // Bundled/embedded browser-side asset, not Node/Bun-executed
        // Vitest-covered code — exercised indirectly via web/*.test.ts's
        // HTML-output assertions, not instrumentable by v8 coverage here.
        "src/web/assets/**",
        "src/web/assets.d.ts",
      ],
      // Measured on 2026-07-24 across all of `src/**`: ~63% statements /
      // ~56% branches / ~64% functions / ~63% lines. That number is real
      // but misleading on its own: `src/cli/commands/**` (and
      // `src/cli/index.ts`) sit at ~0% here NOT because they're
      // untested — every command has an acceptance test under
      // tests/acceptance/ — but because this project's established
      // convention (see e.g. epipe.test.ts's/A1.test.ts's own doc
      // comments) is to exercise them as a genuine SPAWNED subprocess
      // (the compiled `dist/slop` binary, or `bun <entry>`), which v8
      // coverage of the vitest worker process can't see across. The
      // global thresholds below are set just under that honest ~63%
      // baseline, purely to catch a regression in what IS in-process-
      // covered. The glob thresholds catch the thing that actually
      // matters most (this ticket's brief: "prioritize ... core/repo/
      // tickets") with real teeth — each is set a couple points under
      // its own measured number: core ~95/89/100/98, repo ~93/83/98/96,
      // sessions ~94/85/97/95, tickets ~97/91/99/98.
      thresholds: {
        statements: 62,
        branches: 55,
        functions: 63,
        lines: 62,
        "src/core/**": { statements: 94, branches: 87, functions: 99, lines: 97 },
        "src/repo/**": { statements: 91, branches: 82, functions: 97, lines: 94 },
        "src/sessions/**": { statements: 92, branches: 84, functions: 95, lines: 94 },
        "src/tickets/**": { statements: 95, branches: 89, functions: 98, lines: 96 },
      },
    },
  },
});
