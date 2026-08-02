import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "http://localhost/" } },
    include: ["src/web/frontend/**/*.test.tsx"],
    setupFiles: ["./src/web/frontend/test-setup.ts"],
    testTimeout: 10_000,
  },
});
