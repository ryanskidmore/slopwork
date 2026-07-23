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
  },
});
