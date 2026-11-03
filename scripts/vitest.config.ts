// Tests for the repository scripts: `pnpm test:scripts` from the repo root.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['*.test.ts'],
    environment: 'node',
  },
});
