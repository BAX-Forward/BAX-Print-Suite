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

// Markup openers are built from the code point so that no literal bang character appears here.
const DOCTYPE = `<${String.fromCharCode(0x21)}DOCTYPE`;
const SVG = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm"/>');
const DXF = new TextEncoder().encode('  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1027\n  0\nENDSEC\n  0\nEOF\n');

describe('Spec 035b: JobService records the vector source formats', () => {
  it.each([
    ['a.svg', SVG, 'svg'],
    ['a.dxf', DXF, 'dxf'],
    // The name is never trusted: the bytes decide, as for raster in Spec 031c.
    ['a.dxf', SVG, 'svg'],
    ['a.svg', DXF, 'dxf'],
    ['a.pdf', SVG, 'svg'],
  ] as const)('records %s with %s bytes from its header', async (name, bytes, format) => {
    const { jobs, repository } = createServerHarness();

    const job = await jobs.create({ name, sources: [{ name, bytes }], ticket: TICKET });

    expect(job.sourceFormat).toBe(format);
    expect((await repository.get(job.id))?.sourceFormat).toBe(format);
  });

  it('records an SVG with a DOCTYPE and external references as svg without resolving them', async () => {
    const { jobs } = createServerHarness();
    const text = `${DOCTYPE} svg SYSTEM "http://127.0.0.1:9/evil.dtd"><svg width="1in" height="1in"><image href="http://127.0.0.1:9/a.png"/></svg>`;

    const job = await jobs.create({ name: 'refs.svg', sources: [{ name: 'refs.svg', bytes: new TextEncoder().encode(text) }], ticket: TICKET });

    expect(job.sourceFormat).toBe('svg');
  });

  it('omits the field for text that is neither SVG nor DXF, whatever its name', async () => {
    const { jobs } = createServerHarness();

    const html = await jobs.create({ name: 'a.svg', sources: [{ name: 'a.svg', bytes: new TextEncoder().encode('<html></html>') }], ticket: TICKET });
    const text = await jobs.create({ name: 'a.dxf', sources: [{ name: 'a.dxf', bytes: new TextEncoder().encode('hello') }], ticket: TICKET });

    expect('sourceFormat' in html).toBe(false);
    expect('sourceFormat' in text).toBe(false);
  });
});
