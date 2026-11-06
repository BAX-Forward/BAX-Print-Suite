import { describe, expect, it } from 'vitest';
import { type HotFolderSettings, withHotFolderDefaults } from '../src/index.js';

/**
 * Spec 037c: hot-folder settings have no strict server schema, so `withHotFolderDefaults` is the
 * only gate for `acceptJdf`. It keeps the flag only when it is literally `true`.
 */
describe('withHotFolderDefaults acceptJdf', () => {
  it('keeps acceptJdf when it is true', () => {
    expect(withHotFolderDefaults({ acceptJdf: true }).acceptJdf).toBe(true);
  });

  it('leaves acceptJdf off when it is unset', () => {
    const settings = withHotFolderDefaults({});
    expect(settings.acceptJdf).toBeUndefined();
    expect('acceptJdf' in settings).toBe(false);
    expect('acceptJdf' in withHotFolderDefaults()).toBe(false);
  });

  it('drops acceptJdf when it is false', () => {
    expect('acceptJdf' in withHotFolderDefaults({ acceptJdf: false })).toBe(false);
  });

  it.each<[string, unknown]>([
    ['the string "true"', 'true'],
    ['the number 1', 1],
  ])('drops a non-boolean acceptJdf (%s)', (_label, value) => {
    // Stored settings are JSON, so a non-boolean can reach this function at run time.
    const raw = JSON.parse(JSON.stringify({ acceptJdf: value })) as Partial<HotFolderSettings>;
    expect('acceptJdf' in withHotFolderDefaults(raw)).toBe(false);
  });
});
