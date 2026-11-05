import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CloudEvent } from '@bax-print/events';
import { createEvent } from '@bax-print/events';
import { sha256Hex } from '@bax-print/store';
import {
  HISTORY_PATH,
  MANIFEST_PATH,
  MEMBER_ROLES,
  pack,
  PackageIntegrityError,
  readZip,
  unpack,
  writeZip,
  type PackInput,
} from '../src/index.js';
import { bytesOf, DEVICE_A, fileRecord, makeJob, MEDIUM_GLOSS, revision } from './helpers.js';

/** Deterministic bytes that do not compress, so the ZIP stores them verbatim. */
function noise(seed: string, length: number): Uint8Array {
  const chunks: Buffer[] = [];
  let block = createHash('sha256').update(seed).digest();
  while (chunks.length * 32 < length) {
    chunks.push(block);
    block = createHash('sha256').update(block).digest();
  }
  return Buffer.concat(chunks).subarray(0, length);
}

const SOURCE = noise('artwork', 512);
const LAYOUT = bytesOf('%PDF-1.7 imposed layout');
const CUT = bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 L 5 0 L 5 5 Z"/></svg>');
const PREVIEW = noise('preview', 64);
const OPEN_PROFILE = bytesOf('open profile bytes');
const LICENSED_PROFILE = bytesOf('licensed profile bytes');

function history(jobId: string): CloudEvent[] {
  return [
    createEvent({ type: 'job.created', source: '/bps/jobs', subject: jobId, data: { jobId } }, 'evt-1', new Date('2026-02-01T08:00:00Z')),
    createEvent(
      { type: 'job.status.changed', source: '/bps/jobs', subject: jobId, data: { jobId, from: 'printed', to: 'done' } },
      'evt-2',
      new Date('2026-02-01T10:00:00Z'),
    ),
  ];
}

function packInput(): PackInput {
  const rev = revision('rev-1', DEVICE_A, MEDIUM_GLOSS, [
    { id: 'prof-open', fileName: 'open.icc', sha256: sha256Hex(OPEN_PROFILE), redistributable: true, license: 'CC0-1.0' },
    { id: 'prof-licensed', fileName: 'licensed.icc', sha256: sha256Hex(LICENSED_PROFILE), redistributable: false },
  ]);
  const job = makeJob({
    id: 'pkg-001',
    customerRef: 'C-42',
    deviceId: DEVICE_A,
    mediumId: MEDIUM_GLOSS,
    colorSetupRevisionId: rev.id,
    tags: ['spring', 'window'],
    metadata: { order: 'SO-7781' },
    sourceFiles: [fileRecord('artwork.pdf', SOURCE, 'jobs/pkg-001/source/0-artwork.pdf')],
    artifacts: [
      { ...fileRecord('imposed.pdf', LAYOUT, 'jobs/pkg-001/layout/0-imposed.pdf'), role: 'layout' },
      { ...fileRecord('cut.svg', CUT, 'jobs/pkg-001/cut/1-cut.svg'), role: 'cut' },
      { ...fileRecord('thumb.png', PREVIEW, 'jobs/pkg-001/preview/2-thumb.png'), role: 'preview' },
    ],
  });
  return {
    job,
    sources: [SOURCE],
    artifacts: [LAYOUT, CUT, PREVIEW],
    colorRevisions: [rev],
    profiles: new Map([
      ['prof-open', OPEN_PROFILE],
      ['prof-licensed', LICENSED_PROFILE],
    ]),
    history: history(job.id),
    createdAt: new Date('2026-02-15T12:00:00Z'),
  };
}

function rezip(entries: Map<string, Uint8Array>): Uint8Array {
  return writeZip([...entries].map(([name, data]) => ({ name, data })));
}

describe('job package pack → unpack', () => {
  it('round-trips every member hash-identically', () => {
    const input = packInput();
    const { bytes, manifest } = pack(input);

    const entries = readZip(bytes);
    expect([...entries.keys()].sort()).toEqual([MANIFEST_PATH, ...manifest.members.map((m) => m.path)].sort());
    for (const member of manifest.members) {
      expect(sha256Hex(entries.get(member.path) as Uint8Array)).toBe(member.sha256);
    }

    const unpacked = unpack(bytes);
    expect(unpacked.manifest).toEqual(manifest);
    expect(unpacked.sources.map(sha256Hex)).toEqual(input.sources.map(sha256Hex));
    expect(unpacked.artifacts.map(sha256Hex)).toEqual(input.artifacts.map(sha256Hex));
    expect(sha256Hex(unpacked.profiles.get('prof-open') as Uint8Array)).toBe(sha256Hex(OPEN_PROFILE));
    expect(unpacked.colorRevisions).toEqual(input.colorRevisions);
    expect(unpacked.history).toEqual(input.history);
    expect(unpacked.job.ticket).toEqual(input.job.ticket);

    const { sourceFiles, artifacts, ...rest } = unpacked.job;
    const { sourceFiles: inSources, artifacts: inArtifacts, ...inRest } = input.job;
    expect(rest).toEqual(inRest);
    expect(sourceFiles.map(({ storageKey: _key, ...file }) => file)).toEqual(inSources.map(({ storageKey: _key, ...file }) => file));
    expect(artifacts.map(({ storageKey: _key, ...a }) => a)).toEqual(inArtifacts.map(({ storageKey: _key, ...a }) => a));
  });

  it('records a SHA-256 for every member, including ticket and history', () => {
    const { manifest } = pack(packInput());
    expect(manifest.format).toBe('bpsjob');
    expect(manifest.packageVersion).toBe(1);
    expect(manifest.jobId).toBe('pkg-001');
    const roles = manifest.members.map((m) => m.role);
    for (const role of ['job', 'ticket', 'color', 'history', 'source', 'profile', 'layout', 'cut', 'preview']) {
      expect(roles).toContain(role);
    }
    expect(manifest.members.every((m) => /^[0-9a-f]{64}$/.test(m.sha256))).toBe(true);
  });

  it('is deterministic, and re-packing an unpacked package gives the same bytes', () => {
    const input = packInput();
    const first = pack(input).bytes;
    expect(Buffer.compare(Buffer.from(first), Buffer.from(pack(input).bytes))).toBe(0);

    const unpacked = unpack(first);
    const repacked = pack({ ...unpacked, createdAt: input.createdAt }).bytes;
    expect(sha256Hex(repacked)).toBe(sha256Hex(first));
  });

  it('packs and unpacks a normalized artifact (Spec 007 FR3)', () => {
    const input = packInput();
    const NORMALIZED = bytesOf('%PDF-1.6 PDF/X-4 rewrite');
    const job = {
      ...input.job,
      artifacts: [
        ...input.job.artifacts,
        { ...fileRecord('artwork-pdfx4.pdf', NORMALIZED, 'jobs/pkg-001/normalized/3-artwork-pdfx4.pdf'), role: 'normalized' as const },
      ],
    };
    const { bytes, manifest } = pack({ ...input, job, artifacts: [...input.artifacts, NORMALIZED] });
    expect(manifest.members.find((m) => m.role === 'normalized')?.path).toBe('normalized/3-artwork-pdfx4.pdf');
    const unpacked = unpack(bytes);
    expect(unpacked.job.artifacts.map((a) => a.role)).toEqual(['layout', 'cut', 'preview', 'normalized']);
    const normalized = unpacked.artifacts[3];
    if (!normalized) throw new Error('package has no normalized artifact');
    expect(sha256Hex(normalized)).toBe(sha256Hex(NORMALIZED));
  });

  it('leaves out profiles that are not redistributable and says so', () => {
    const { bytes, manifest, warnings } = pack(packInput());
    expect(manifest.omittedProfiles).toEqual([{ revisionId: 'rev-1', profileId: 'prof-licensed', reason: 'not-redistributable' }]);
    expect(warnings.some((w) => w.includes('prof-licensed'))).toBe(true);
    const unpacked = unpack(bytes);
    expect(unpacked.profiles.has('prof-licensed')).toBe(false);
    expect([...readZip(bytes).keys()].some((name) => name.includes('licensed'))).toBe(false);
  });

  it('records a redistributable profile it could not read as unavailable', () => {
    const input = packInput();
    const { manifest } = pack({ ...input, profiles: new Map() });
    expect(manifest.omittedProfiles).toContainEqual({ revisionId: 'rev-1', profileId: 'prof-open', reason: 'unavailable' });
  });

  it('refuses to pack bytes that do not match the job record', () => {
    const input = packInput();
    expect(() => pack({ ...input, sources: [bytesOf('something else')] })).toThrow(PackageIntegrityError);
    expect(() => pack({ ...input, artifacts: [] })).toThrow(PackageIntegrityError);
  });
});

describe('tampered packages', () => {
  it('fails with PackageIntegrityError when a member is changed', () => {
    const { bytes, manifest } = pack(packInput());
    const entries = readZip(bytes);
    const sourcePath = manifest.members.find((m) => m.role === 'source')?.path as string;
    const altered = new Uint8Array(entries.get(sourcePath) as Uint8Array);
    const [head] = altered;
    if (head === undefined) throw new Error('source member is empty');
    altered[0] = head ^ 0xff;
    entries.set(sourcePath, altered);

    expect(() => unpack(rezip(entries))).toThrow(PackageIntegrityError);
    expect(() => unpack(rezip(entries))).toThrow(/does not match its SHA-256/);
  });

  it('fails even when the manifest hash is rewritten to match, because job.json records the original hash', () => {
    const { bytes, manifest } = pack(packInput());
    const entries = readZip(bytes);
    const sourcePath = manifest.members.find((m) => m.role === 'source')?.path as string;
    const altered = bytesOf('replaced artwork');
    entries.set(sourcePath, altered);
    const forged = {
      ...manifest,
      members: manifest.members.map((m) => (m.path === sourcePath ? { ...m, sha256: sha256Hex(altered), size: altered.byteLength } : m)),
    };
    entries.set(MANIFEST_PATH, bytesOf(JSON.stringify(forged)));

    expect(() => unpack(rezip(entries))).toThrow(PackageIntegrityError);
  });

  it('fails when the history is edited', () => {
    const { bytes } = pack(packInput());
    const entries = readZip(bytes);
    const text = Buffer.from(entries.get(HISTORY_PATH) as Uint8Array).toString('utf8');
    entries.set(HISTORY_PATH, bytesOf(text.replace('"to":"done"', '"to":"failed"')));
    expect(() => unpack(rezip(entries))).toThrow(PackageIntegrityError);
  });

  it('fails when a byte of the archive itself is flipped', () => {
    const { bytes } = pack(packInput());
    const raw = Buffer.from(bytes);
    const at = raw.indexOf(Buffer.from(SOURCE));
    expect(at).toBeGreaterThan(0);
    const target = raw[at + 100];
    if (target === undefined) throw new Error('archive is shorter than expected');
    raw[at + 100] = target ^ 0x01;
    expect(() => unpack(raw)).toThrow(PackageIntegrityError);
  });

  it('fails when a member is missing or an unlisted member is added', () => {
    const { bytes, manifest } = pack(packInput());
    const missing = readZip(bytes);
    missing.delete(manifest.members.find((m) => m.role === 'cut')?.path as string);
    expect(() => unpack(rezip(missing))).toThrow(PackageIntegrityError);

    const extra = readZip(bytes);
    extra.set('source/9-extra.pdf', bytesOf('smuggled'));
    expect(() => unpack(rezip(extra))).toThrow(/not listed in the manifest/);
  });

  it('fails on bytes that are not a package', () => {
    expect(() => unpack(bytesOf('not a zip at all, just text'))).toThrow(PackageIntegrityError);
    expect(() => unpack(writeZip([{ name: 'readme.txt', data: bytesOf('hi') }]))).toThrow(/no manifest.json/);
  });

  it('rejects a newer package version', () => {
    const { bytes, manifest } = pack(packInput());
    const entries = readZip(bytes);
    entries.set(MANIFEST_PATH, bytesOf(JSON.stringify({ ...manifest, packageVersion: 2 })));
    expect(() => unpack(rezip(entries))).toThrow(/unsupported packageVersion/);
  });
});

describe('manifest schema', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/manifest.schema.json', import.meta.url), 'utf8')) as {
    required: string[];
    properties: { members: { items: { properties: { role: { enum: string[] } } } } };
  };

  it('lists the same member roles as the code', () => {
    expect(schema.properties.members.items.properties.role.enum).toEqual([...MEMBER_ROLES]);
  });

  it('requires every field the packer always writes', () => {
    const { manifest } = pack(packInput());
    for (const field of schema.required) {
      expect(manifest).toHaveProperty(field);
    }
  });
});
