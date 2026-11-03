import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // pdf.js rendering tests rasterize several pages.
    testTimeout: 30_000,
  },
});
