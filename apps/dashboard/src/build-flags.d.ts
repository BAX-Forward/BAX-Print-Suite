/**
 * Compile-time constants injected by Vite `define` (vite.config.ts, vitest.config.ts).
 * Guard every use with `if (__BPS_TILE_PREVIEW__)` so production builds drop the code when off.
 */
declare const __BPS_TILE_PREVIEW__: boolean;
