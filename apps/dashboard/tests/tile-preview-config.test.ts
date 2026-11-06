// @vitest-environment node
import type { UserConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TILE_PREVIEW_ENV } from '../src/lib/buildFlags';
import { WORKSPACE_SOURCE_CONDITION } from '../src/lib/tilePreviewPage';
import viteConfig from '../vite.config';

/**
 * Spec 049c: the job page wiring lives in vite.config.ts. With the flag off the config adds no plugin
 * and no resolve conditions, so the flag-off dist is what main builds; with it on it adds both.
 */

const PAGE_PLUGIN = 'bps-tile-preview-page';

afterEach(() => {
  vi.unstubAllEnvs();
});

function build(): UserConfig {
  return viteConfig({ command: 'build', mode: 'production' });
}

function pluginNames(config: UserConfig): string[] {
  return (config.plugins ?? [])
    .flat()
    .flatMap((plugin) =>
      typeof plugin === 'object' && plugin !== null && 'name' in plugin && typeof plugin.name === 'string'
        ? [plugin.name]
        : [],
    );
}

describe('tile preview build wiring', () => {
  it('adds neither the page plugin nor resolve conditions with the flag off', () => {
    const saved = process.env[TILE_PREVIEW_ENV];
    delete process.env[TILE_PREVIEW_ENV];
    try {
      const config = build();
      expect(pluginNames(config)).not.toContain(PAGE_PLUGIN);
      expect(config.resolve).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env[TILE_PREVIEW_ENV] = saved;
    }
  });

  it('swaps in the tile job page and reads the layout entry from source with the flag on', () => {
    vi.stubEnv(TILE_PREVIEW_ENV, '1');
    const config = build();
    expect(pluginNames(config)).toContain(PAGE_PLUGIN);
    expect(config.resolve?.conditions).toContain(WORKSPACE_SOURCE_CONDITION);
  });
});
