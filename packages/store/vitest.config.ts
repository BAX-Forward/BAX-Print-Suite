import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // node:sqlite is behind this flag before Node 22.13; later versions accept it as a no-op.
    pool: "forks",
    poolOptions: {
      forks: { execArgv: ["--experimental-sqlite"] },
    },
  },
});
