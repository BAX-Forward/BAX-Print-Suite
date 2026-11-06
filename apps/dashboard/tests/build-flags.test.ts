// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBuildFlag, TILE_PREVIEW_ENV, tilePreviewFlag } from '../src/lib/buildFlags';
import viteConfig from '../vite.config';

/** Spec 049a: BPS_DASHBOARD_TILE_PREVIEW is read at build time; unset is off, "1" is on, the rest stop the build. */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseBuildFlag', () => {
  it('is off when unset and on for exactly "1"', () => {
    expect(parseBuildFlag(TILE_PREVIEW_ENV, undefined)).toBe(false);
    expect(parseBuildFlag(TILE_PREVIEW_ENV, '1')).toBe(true);
    expect(tilePreviewFlag({})).toBe(false);
    expect(tilePreviewFlag({ [TILE_PREVIEW_ENV]: '1' })).toBe(true);
  });

  it.each(['0', 'true', ' 1', '1 ', '', 'yes', 'on'])('rejects %j', (value) => {
    expect(() => tilePreviewFlag({ [TILE_PREVIEW_ENV]: value })).toThrow(
      `${TILE_PREVIEW_ENV} must be unset or exactly "1" (got ${JSON.stringify(value)})`,
    );
  });
});

describe('vite.config.ts', () => {
  const build = () => viteConfig({ command: 'build', mode: 'production' });

  it('compiles the flag in as a boolean constant', () => {
    vi.stubEnv(TILE_PREVIEW_ENV, '1');
    expect(build().define).toEqual({ __BPS_TILE_PREVIEW__: 'true' });
  });

  it('defaults to off', () => {
    const saved = process.env[TILE_PREVIEW_ENV];
    delete process.env[TILE_PREVIEW_ENV];
    try {
      expect(build().define).toEqual({ __BPS_TILE_PREVIEW__: 'false' });
    } finally {
      if (saved !== undefined) process.env[TILE_PREVIEW_ENV] = saved;
    }
  });

  it.each(['0', 'true', ' 1'])('stops the build for %j', (value) => {
    vi.stubEnv(TILE_PREVIEW_ENV, value);
    expect(build).toThrow(TILE_PREVIEW_ENV);
  });
});
