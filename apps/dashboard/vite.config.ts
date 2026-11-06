import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { tilePreviewFlag } from './src/lib/buildFlags';

/** Where `pnpm dev` proxies API calls. Override with BPS_API_URL. */
const DEFAULT_API_TARGET = 'http://127.0.0.1:8080';

/** Top-level API paths from /openapi.json. The UI itself lives under /ui. */
const API_PREFIXES = [
  '/health',
  '/openapi.json',
  '/jobs',
  '/hotfolders',
  '/devices',
  '/plugins',
  '/events',
];

// pdfjs-dist 4.x uses top-level await.
const BUILD_TARGET = 'es2022';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.BPS_API_URL || DEFAULT_API_TARGET;
  const proxy =
    mode === 'mock'
      ? undefined
      : Object.fromEntries(API_PREFIXES.map((prefix) => [prefix, { target }]));
  // Throws on any value other than unset or "1", which stops the build or dev server.
  const tilePreview = tilePreviewFlag(process.env);

  return {
    base: '/ui/',
    plugins: [react()],
    define: { __BPS_TILE_PREVIEW__: JSON.stringify(tilePreview) },
    server: { host: '127.0.0.1', proxy },
    worker: { format: 'es' },
    optimizeDeps: { esbuildOptions: { target: BUILD_TARGET } },
    build: { outDir: 'dist', target: BUILD_TARGET, sourcemap: true },
  };
});
