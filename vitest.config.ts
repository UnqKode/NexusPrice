import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // Pinned so date/timezone-sensitive logic behaves identically in CI
    // regardless of the runner's own local timezone - without this, tests
    // can pass or fail depending on where they happen to run (this is
    // exactly what let a real timezone bug through review once already;
    // see src/lib/dateRange.ts). The adversarial timezone suite
    // deliberately overrides this per-file - see
    // vitest.adversarial-tz.config.ts, run explicitly via `npm run
    // test:tz-adversarial`, not part of this default run.
    env: {
      TZ: "UTC",
    },
    exclude: [...configDefaults.exclude, "**/*.adversarial-tz.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
