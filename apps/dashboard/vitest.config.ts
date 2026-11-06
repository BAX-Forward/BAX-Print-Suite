import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Feature flags are off in tests; tests render flagged components directly.
  define: { __BPS_TILE_PREVIEW__: 'false' },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
