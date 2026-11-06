import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { WORKSPACE_SOURCE_CONDITION } from './src/lib/tilePreviewPage';

export default defineConfig({
  plugins: [react()],
  // Feature flags are off in tests; tests render flagged components directly.
  define: { __BPS_TILE_PREVIEW__: 'false' },
  // Prefer workspace TypeScript sources (@bax-print/tile/layout) so tests do not need a prior build.
  resolve: { conditions: [WORKSPACE_SOURCE_CONDITION, ...defaultClientConditions] },
  ssr: { resolve: { conditions: [WORKSPACE_SOURCE_CONDITION, ...defaultServerConditions] } },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
