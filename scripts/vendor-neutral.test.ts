import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildMatcher,
  defaultRoots,
  EXEMPT_ROOTS,
  findTerms,
  loadVendorNames,
  scanRepository,
  type VendorNames,
} from './vendor-neutral.js';

const NAMES: VendorNames = { names: ['acme', 'acme-gl'] };

describe('vendor-neutral matcher', () => {
  it('matches whole words case-insensitively, longest name first', () => {
    const matcher = buildMatcher(NAMES.names);
    expect(findTerms('ACME driver\nuses acme-gl output', matcher, 'f.ts')).toEqual([
      { file: 'f.ts', line: 1, term: 'ACME' },
      { file: 'f.ts', line: 2, term: 'acme-gl' },
    ]);
    expect(findTerms('acmes and subacme are other words', matcher, 'f.ts')).toEqual([]);
  });

  it('refuses an empty name list', () => {
    expect(() => buildMatcher([' '])).toThrow();
  });

  it('loads the shared name list', async () => {
    expect((await loadVendorNames()).names.length).toBeGreaterThan(10);
  });
});

describe('scanRepository', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bps-vendor-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('flags names in the scanned roots but never in other dirs or node_modules', async () => {
    await mkdir(join(root, 'packages', 'core', 'src'), { recursive: true });
    await mkdir(join(root, 'packages', 'core', 'node_modules'), { recursive: true });
    await mkdir(join(root, 'plugins', 'acme'), { recursive: true });
    await writeFile(join(root, 'packages', 'core', 'src', 'device.ts'), 'export const neutral = 1;\n// Acme only\n');
    await writeFile(join(root, 'packages', 'core', 'node_modules', 'dep.js'), 'acme');
    await writeFile(join(root, 'plugins', 'acme', 'index.ts'), 'acme');

    expect(await scanRepository(root, ['packages', 'missing'], NAMES)).toEqual([
      { file: 'packages/core/src/device.ts', line: 2, term: 'Acme' },
    ]);
  });

  it('defaults to every packages/* and apps/* dir, never plugins/ or docs/research/', async () => {
    for (const dir of ['packages/core', 'packages/store', 'apps/server', 'apps/x', 'plugins/acme', 'docs/research/notes']) {
      await mkdir(join(root, dir), { recursive: true });
    }
    await writeFile(join(root, 'packages', 'README.md'), 'not a package dir');

    const roots = await defaultRoots(root);

    expect(roots).toEqual(['apps/server', 'apps/x', 'packages/core', 'packages/store']);
    for (const exempt of EXEMPT_ROOTS) {
      expect(roots.some((r) => r === exempt || r.startsWith(`${exempt}/`))).toBe(false);
    }
  });

  it('returns no default roots when packages/ and apps/ are absent', async () => {
    expect(await defaultRoots(root)).toEqual([]);
  });

  it('reports a vendor name planted in a new apps/ dir with the default roots', async () => {
    await mkdir(join(root, 'apps', 'x', 'src'), { recursive: true });
    await mkdir(join(root, 'plugins', 'acme'), { recursive: true });
    await mkdir(join(root, 'docs', 'research'), { recursive: true });
    await writeFile(join(root, 'apps', 'x', 'src', 'main.ts'), 'const ok = 1;\nconst driver = "acme-gl";\n');
    await writeFile(join(root, 'plugins', 'acme', 'index.ts'), 'acme');
    await writeFile(join(root, 'docs', 'research', 'notes.md'), 'acme');

    expect(await scanRepository(root, await defaultRoots(root), NAMES)).toEqual([
      { file: 'apps/x/src/main.ts', line: 2, term: 'acme-gl' },
    ]);
  });

  it('allows only the exact command-language tokens from vendor-names.json', async () => {
    const shared = await loadVendorNames();
    expect(shared.allowedTokens).toEqual(['HPGL', 'hpgl', 'HP-GL/2']);
    await mkdir(join(root, 'packages', 'cut-export', 'src'), { recursive: true });
    await mkdir(join(root, 'apps', 'server', 'src'), { recursive: true });
    await mkdir(join(root, 'plugins', 'printer-x'), { recursive: true });
    await writeFile(join(root, 'packages', 'cut-export', 'src', 'enc.ts'), '// HPGL and hpgl encoder\n// emits HP-GL/2\n');
    await writeFile(join(root, 'apps', 'server', 'src', 'dev.ts'), '// HP device\n// DesignJet output\n// Hpgl and HP-GL\n');
    await writeFile(join(root, 'plugins', 'printer-x', 'index.ts'), 'HP DesignJet');
    expect(await scanRepository(root, await defaultRoots(root), shared)).toEqual([
      { file: 'apps/server/src/dev.ts', line: 1, term: 'HP' },
      { file: 'apps/server/src/dev.ts', line: 2, term: 'DesignJet' },
      { file: 'apps/server/src/dev.ts', line: 3, term: 'Hpgl' },
      { file: 'apps/server/src/dev.ts', line: 3, term: 'HP-GL' },
    ]);
  });
});
