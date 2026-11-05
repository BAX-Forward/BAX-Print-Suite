import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Prefer workspace TypeScript sources so vitest does not need a prior build.
    conditions: ["@bax-print/source"],
  },
  ssr: {
    resolve: {
      // Vitest's node env uses Vite SSR resolution; keep @bax-print/source first.
      conditions: ["@bax-print/source", "module", "node", "development|production"],
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
