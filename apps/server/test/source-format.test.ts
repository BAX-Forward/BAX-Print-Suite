import { describe, expect, it } from 'vitest';
import { createServerHarness, TICKET } from './helpers.js';

const PDF = new TextEncoder().encode('%PDF-1.7\n%fixture\n');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const TIFF = Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);

describe('Spec 031c: JobService records the source format', () => {
  it.each([
    ['a.pdf', PDF, 'pdf'],
    ['a.png', PNG, 'png'],
    ['a.jpg', JPEG, 'jpeg'],
    ['a.tif', TIFF, 'tiff'],
  ] as const)('records %s as %s from its magic bytes', async (name, bytes, format) => {
    const { jobs, repository } = createServerHarness();

    const job = await jobs.create({ name, sources: [{ name, bytes }], ticket: TICKET });

    expect(job.sourceFormat).toBe(format);
    expect((await repository.get(job.id))?.sourceFormat).toBe(format);
  });

  it('uses the first source and omits the field for unknown bytes', async () => {
    const { jobs } = createServerHarness();

    const mixed = await jobs.create({
      name: 'mixed',
      sources: [
        { name: 'a.png', bytes: PNG },
        { name: 'b.pdf', bytes: PDF },
      ],
      ticket: TICKET,
    });
    const unknown = await jobs.create({ name: 'odd', sources: [{ name: 'odd.bin', bytes: Uint8Array.from([1, 2, 3]) }], ticket: TICKET });

    expect(mixed.sourceFormat).toBe('png');
    expect('sourceFormat' in unknown).toBe(false);
  });
});
