// Acceptance 6: no vendor, model or device command language names in the Spec 008 core directories.
// The name list is the shared scripts/vendor-names.json, so this file names no vendor itself.
import { describe, expect, it } from 'vitest';
import { loadVendorNames, REPO_ROOT, scanRepository, SPEC_008_ROOTS } from '../../../scripts/vendor-neutral.js';

describe('vendor-neutral check', () => {
  it('finds no vendor names in the Spec 008 packages', async () => {
    expect(await scanRepository(REPO_ROOT, SPEC_008_ROOTS, await loadVendorNames())).toEqual([]);
  });
});
