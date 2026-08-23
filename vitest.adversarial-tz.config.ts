import { defineConfig } from "vitest/config";
import path from "path";

// Separate config, run explicitly via `npm run test:tz-adversarial` - not
// part of the default `npm test` run (see the exclude in vitest.config.ts).
// These tests deliberately run under a negative-offset, DST-observing
// timezone to catch the class of bug where local-time Date methods
// (getDate/setDate/getMonth/etc.) silently disagree with the UTC-anchored
// data actually stored in Mongo, depending on which timezone the process
// happens to run in. Keeping this as a separate config rather than
// mutating process.env.TZ inside a shared test file avoids any risk of
// that mutation leaking into other tests via a reused worker process.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["**/*.adversarial-tz.test.ts"],
    env: {
      TZ: "America/Los_Angeles",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
