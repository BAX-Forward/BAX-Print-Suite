// Optional root runner: `pnpm exec vitest run` runs every workspace package
// with its own vitest.config.ts. CI uses `pnpm test` (pnpm -r test) instead.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "plugins/*", "apps/server", "scripts/vitest.config.ts"],
  },
});
