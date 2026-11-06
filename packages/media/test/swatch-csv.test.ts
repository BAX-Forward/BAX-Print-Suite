import { ValidationError } from '@bax-print/core';
import { describe, expect, it } from 'vitest';
import {
  MAX_SWATCH_CSV_BYTES,
  MAX_SWATCH_CSV_ISSUES,
  MAX_SWATCH_NAME_LENGTH,
  MAX_SWATCHES,
  SWATCH_CSV_HEADER,
  parseSwatchCsv,
  swatchesToSpotLibrary,
  writeSwatchCsv,
  type Swatch,
  type SwatchCsvIssue,
  type SwatchCsvResult,
  type SwatchSpace,
} from '../src/index.js';

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const csv = (...rows: string[]): string => [SWATCH_CSV_HEADER, ...rows].map((line) => `${line}\n`).join('');

function issuesOf(input: string | Uint8Array): SwatchCsvIssue[] {
  const result = parseSwatchCsv(typeof input === 'string' ? bytes(input) : input);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.issues;
}

function swatchesOf(input: string | Uint8Array): Swatch[] {
  const result = parseSwatchCsv(typeof input === 'string' ? bytes(input) : input);
  expect(result).toMatchObject({ ok: true });
  return result.ok ? result.swatches : [];
}

function firstIssue(input: string | Uint8Array): SwatchCsvIssue | undefined {
  return issuesOf(input)[0];
}

/** mulberry32: a small seeded PRNG so failures reproduce. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const intIn = (rand: () => number, min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));
const pick = <T>(rand: () => number, items: readonly T[], fallback: T): T => items[intIn(rand, 0, items.length - 1)] ?? fallback;

const NAME_CHARS = ['a', 'Z', '0', ' ', ',', '"', 'é', '\u{1F600}', '-', '#', '\t'];
const SPACES: readonly SwatchSpace[] = ['cmyk', 'lab', 'rgb'];

function randomSwatch(rand: () => number, index: number): Swatch {
  const length = intIn(rand, 0, 12);
  const name = Array.from({ length }, () => pick(rand, NAME_CHARS, 'a')).join('') + `#${index}`;
  const space = pick(rand, SPACES, 'cmyk');
  const hundredths = (min: number, max: number): number => intIn(rand, min * 100, max * 100) / 100 + 0;
  if (space === 'cmyk') return { name, space, values: [0, 1, 2, 3].map(() => hundredths(0, 100)) };
  if (space === 'lab') return { name, space, values: [hundredths(0, 100), hundredths(-128, 127), hundredths(-128, 127)] };
  return { name, space, values: [0, 1, 2].map(() => intIn(rand, 0, 255)) };
}

function expectWellFormed(result: SwatchCsvResult): void {
  if (result.ok) {
    expect(result.swatches.length).toBeLessThanOrEqual(MAX_SWATCHES);
    return;
  }
  expect(result.issues.length).toBeGreaterThan(0);
  expect(result.issues.length).toBeLessThanOrEqual(MAX_SWATCH_CSV_ISSUES);
  for (const issue of result.issues) {
    expect(issue.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(issue.message).not.toBe('');
    if (issue.line !== undefined) {
      expect(Number.isInteger(issue.line)).toBe(true);
      expect(issue.line).toBeGreaterThanOrEqual(1);
    }
  }
}

const ROW_OVERHEAD = ',cmyk,0,0,0,0\n'.length;

function rowWithName(index: number, length: number): string {
  const prefix = `r${index}-`;
  return `${prefix}${'x'.repeat(length - prefix.length)},cmyk,0,0,0,0\n`;
}

/** A valid file of exactly `size` bytes, made of rows with names of at most 250 characters. */
function csvOfSize(size: number): Uint8Array {
  const header = `${SWATCH_CSV_HEADER}\n`;
  const fullRow = 250 + ROW_OVERHEAD;
  const rows: string[] = [];
  let remaining = size - header.length;
  while (remaining >= 2 * fullRow) {
    rows.push(rowWithName(rows.length, 250));
    remaining -= fullRow;
  }
  const half = Math.floor(remaining / 2);
  rows.push(rowWithName(rows.length, half - ROW_OVERHEAD), rowWithName(rows.length + 1, remaining - half - ROW_OVERHEAD));
  const result = bytes(header + rows.join(''));
  expect(result.length).toBe(size);
  return result;
}

const rgbRows = (count: number): string[] => Array.from({ length: count }, (_, i) => `s${i},rgb,0,0,0,`);

describe('parseSwatchCsv: valid files', () => {
  it('reads cmyk, lab and rgb swatches', () => {
    const text = csv('Paper White,cmyk,0,0,0,0', 'Deep Red,lab,45.5,62.25,-3,', 'Sky,rgb,12,140,255,', 'Ink,cmyk,100,90.5,0,12');
    expect(swatchesOf(text)).toEqual([
      { name: 'Paper White', space: 'cmyk', values: [0, 0, 0, 0] },
      { name: 'Deep Red', space: 'lab', values: [45.5, 62.25, -3] },
      { name: 'Sky', space: 'rgb', values: [12, 140, 255] },
      { name: 'Ink', space: 'cmyk', values: [100, 90.5, 0, 12] },
    ]);
  });

  it('accepts a header with no rows, with or without a final line break', () => {
    expect(swatchesOf(SWATCH_CSV_HEADER)).toEqual([]);
    expect(swatchesOf(`${SWATCH_CSV_HEADER}\n`)).toEqual([]);
    expect(swatchesOf(`${SWATCH_CSV_HEADER}\r\n`)).toEqual([]);
  });

  it('accepts a last row without a line break', () => {
    expect(swatchesOf(`${SWATCH_CSV_HEADER}\na,rgb,1,2,3,`)).toEqual([{ name: 'a', space: 'rgb', values: [1, 2, 3] }]);
  });

  it('strips a byte order mark', () => {
    const body = bytes(csv('a,rgb,1,2,3,'));
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    expect(swatchesOf(withBom)).toEqual([{ name: 'a', space: 'rgb', values: [1, 2, 3] }]);
  });

  it('accepts CRLF and mixed line endings', () => {
    const rows = ['a,rgb,1,2,3,', 'b,lab,50,0,0,'];
    const expected = swatchesOf(csv(...rows));
    expect(swatchesOf([SWATCH_CSV_HEADER, ...rows].map((line) => `${line}\r\n`).join(''))).toEqual(expected);
    expect(swatchesOf(`${SWATCH_CSV_HEADER}\r\n${rows[0] ?? ''}\n${rows[1] ?? ''}\r\n`)).toEqual(expected);
  });

  it('reads quoted names with commas and escaped quotes, and keeps names verbatim', () => {
    const text = csv('"Red, warm",rgb,1,2,3,', '"say ""hi""",rgb,1,2,3,', ' padded ,rgb,1,2,3,', '"""",rgb,1,2,3,');
    expect(swatchesOf(text).map((s) => s.name)).toEqual(['Red, warm', 'say "hi"', ' padded ', '"']);
  });

  it('accepts values at the range limits and normalises -0', () => {
    const [cmyk, lab, rgb] = swatchesOf(csv('a,cmyk,100,0,100.0,0', 'b,lab,0,-128,127,', 'c,rgb,0,255,-0,'));
    expect(cmyk?.values).toEqual([100, 0, 100, 0]);
    expect(lab?.values).toEqual([0, -128, 127]);
    expect(rgb?.values).toEqual([0, 255, 0]);
    expect(Object.is(rgb?.values[2], 0)).toBe(true);
  });

  it('compares names exactly, so case and spacing variants are distinct', () => {
    expect(swatchesOf(csv('a,rgb,1,2,3,', 'A,rgb,1,2,3,', ' a,rgb,1,2,3,'))).toHaveLength(3);
  });
});

describe('parseSwatchCsv: header and file errors', () => {
  it('reports an empty file', () => {
    expect(issuesOf('')).toEqual([expect.objectContaining({ code: 'EMPTY_FILE' })]);
    expect(firstIssue(new Uint8Array([0xef, 0xbb, 0xbf]))?.code).toBe('EMPTY_FILE');
  });

  it('requires the exact, case-sensitive header on line 1', () => {
    for (const header of ['Name,space,v1,v2,v3,v4', 'name,space,v1,v2,v3', 'name,space,v1,v2,v3,v4,v5', 'name, space,v1,v2,v3,v4', 'a,rgb,1,2,3,', '\n']) {
      expect(issuesOf(`${header}\na,rgb,1,2,3,\n`)).toEqual([expect.objectContaining({ code: 'BAD_HEADER', line: 1 })]);
    }
    expect(firstIssue(`\u{FEFF}\u{FEFF}${SWATCH_CSV_HEADER}\n`)?.code).toBe('BAD_HEADER');
  });

  it('rejects invalid UTF-8', () => {
    const body = bytes(csv('a,rgb,1,2,3,'));
    expect(issuesOf(new Uint8Array([...body, 0xff]))).toEqual([expect.objectContaining({ code: 'INVALID_UTF8' })]);
    expect(firstIssue(new Uint8Array([...bytes(`${SWATCH_CSV_HEADER}\n`), 0xc3, 0x28, 0x2c]))?.code).toBe('INVALID_UTF8');
  });

  it('reports non-byte input instead of throwing', () => {
    const result: unknown = Reflect.apply(parseSwatchCsv, undefined, ['name,space']);
    expect(result).toMatchObject({ ok: false, issues: [{ code: 'INVALID_INPUT' }] });
  });
});

describe('parseSwatchCsv: row errors', () => {
  it('rejects malformed numbers', () => {
    for (const text of ['1e2', '+5', '.5', '5.', 'abc', '', ' 5', '5 ', '0x10', 'Infinity', 'NaN', '1..2', '--1', '"5"']) {
      expect(issuesOf(csv(`n,cmyk,${text},0,0,0`))).toEqual([expect.objectContaining({ code: 'BAD_NUMBER', line: 2 })]);
    }
  });

  it('rejects out-of-range values for every space', () => {
    for (const row of [
      'n,cmyk,100.01,0,0,0',
      'n,cmyk,0,-0.5,0,0',
      'n,cmyk,0,0,0,101',
      'n,lab,101,0,0,',
      'n,lab,50,-128.5,0,',
      'n,lab,50,0,127.01,',
      'n,rgb,256,0,0,',
      'n,rgb,0,-1,0,',
      'n,rgb,0,0,12.5,',
    ]) {
      expect(issuesOf(csv(row))).toEqual([expect.objectContaining({ code: 'OUT_OF_RANGE', line: 2 })]);
    }
  });

  it('requires v4 to be empty for lab and rgb, and present for cmyk', () => {
    expect(firstIssue(csv('n,lab,50,0,0,0'))).toMatchObject({ code: 'UNEXPECTED_VALUE', line: 2 });
    expect(firstIssue(csv('n,rgb,1,2,3,4'))).toMatchObject({ code: 'UNEXPECTED_VALUE', line: 2 });
    expect(firstIssue(csv('n,cmyk,1,2,3,'))).toMatchObject({ code: 'BAD_NUMBER', line: 2 });
    expect(firstIssue(csv('n,lab,50,0,,'))).toMatchObject({ code: 'BAD_NUMBER', line: 2 });
  });

  it('rejects an unknown or wrongly cased space', () => {
    for (const space of ['CMYK', 'Lab', 'hsv', '']) {
      expect(issuesOf(csv(`n,${space},0,0,0,0`))).toEqual([expect.objectContaining({ code: 'BAD_SPACE', line: 2 })]);
    }
  });

  it('rejects the wrong number of columns', () => {
    for (const row of ['n,cmyk,0,0,0', 'n,cmyk,0,0,0,0,0', 'n', '"n"', '"a,b",rgb,1,2,3', 'n,rgb,1,2,3,,']) {
      expect(issuesOf(csv(row))).toEqual([expect.objectContaining({ code: 'COLUMN_COUNT', line: 2 })]);
    }
  });

  it('rejects an unterminated quote, including a name that spans lines', () => {
    expect(issuesOf(csv('"abc,cmyk,0,0,0,0'))).toEqual([expect.objectContaining({ code: 'UNTERMINATED_QUOTE', line: 2 })]);
    expect(firstIssue(csv('"abc""'))).toMatchObject({ code: 'UNTERMINATED_QUOTE', line: 2 });
    expect(firstIssue(csv('"two', 'lines",rgb,1,2,3,'))).toMatchObject({ code: 'UNTERMINATED_QUOTE', line: 2 });
  });

  it('rejects stray quotes', () => {
    expect(issuesOf(csv('"a"b,cmyk,0,0,0,0'))).toEqual([expect.objectContaining({ code: 'BAD_QUOTE', line: 2 })]);
    expect(issuesOf(csv('a"b,cmyk,0,0,0,0'))).toEqual([expect.objectContaining({ code: 'BAD_QUOTE', line: 2 })]);
    expect(issuesOf(csv('"a" ,cmyk,0,0,0,0'))).toEqual([expect.objectContaining({ code: 'BAD_QUOTE', line: 2 })]);
  });

  it('rejects empty names', () => {
    expect(issuesOf(csv(',cmyk,0,0,0,0'))).toEqual([expect.objectContaining({ code: 'EMPTY_NAME', line: 2 })]);
    expect(issuesOf(csv('"",cmyk,0,0,0,0'))).toEqual([expect.objectContaining({ code: 'EMPTY_NAME', line: 2 })]);
  });

  it('rejects exact duplicate names, pointing at the first occurrence', () => {
    const issues = issuesOf(csv('a,rgb,1,2,3,', 'b,rgb,1,2,3,', 'a,lab,50,0,0,', '"a",cmyk,0,0,0,0'));
    expect(issues.map((issue) => [issue.code, issue.line])).toEqual([
      ['DUPLICATE_NAME', 4],
      ['DUPLICATE_NAME', 5],
    ]);
    expect(issues[0]?.message).toContain('line 2');
  });

  it('rejects blank lines other than a final line break, and stray carriage returns', () => {
    expect(issuesOf(csv('a,rgb,1,2,3,', '', 'b,rgb,1,2,3,'))).toEqual([expect.objectContaining({ code: 'BLANK_LINE', line: 3 })]);
    expect(issuesOf(`${csv('a,rgb,1,2,3,')}\n`)).toEqual([expect.objectContaining({ code: 'BLANK_LINE', line: 3 })]);
    expect(issuesOf(csv('a\r,rgb,1,2,3,'))).toEqual([expect.objectContaining({ code: 'STRAY_CR', line: 2 })]);
    expect(issuesOf(csv('a,rgb,1,2,3,\r\r'))).toEqual([expect.objectContaining({ code: 'STRAY_CR', line: 2 })]);
  });

  it('reports every problem with its line', () => {
    const issues = issuesOf(csv('ok,rgb,1,2,3,', 'bad,rgb,300,x,3,9', 'short,rgb', ',hsv,0,0,0,0'));
    expect(issues.map((issue) => [issue.code, issue.line])).toEqual([
      ['OUT_OF_RANGE', 3],
      ['BAD_NUMBER', 3],
      ['UNEXPECTED_VALUE', 3],
      ['COLUMN_COUNT', 4],
      ['EMPTY_NAME', 5],
      ['BAD_SPACE', 5],
    ]);
  });
});

describe('parseSwatchCsv: caps', () => {
  it('accepts a file of exactly MAX_SWATCH_CSV_BYTES and rejects one byte more before decoding', () => {
    expect(swatchesOf(csvOfSize(MAX_SWATCH_CSV_BYTES)).length).toBeGreaterThan(0);
    expect(issuesOf(csvOfSize(MAX_SWATCH_CSV_BYTES + 1))).toEqual([expect.objectContaining({ code: 'FILE_TOO_LARGE' })]);
    expect(firstIssue(new Uint8Array(MAX_SWATCH_CSV_BYTES + 1).fill(0xff))?.code).toBe('FILE_TOO_LARGE');
  });

  it('accepts exactly MAX_SWATCHES rows and rejects one more before decoding', () => {
    expect(swatchesOf(csv(...rgbRows(MAX_SWATCHES)))).toHaveLength(MAX_SWATCHES);
    expect(swatchesOf([SWATCH_CSV_HEADER, ...rgbRows(MAX_SWATCHES)].join('\n'))).toHaveLength(MAX_SWATCHES);
    expect(issuesOf(csv(...rgbRows(MAX_SWATCHES + 1)))).toEqual([expect.objectContaining({ code: 'TOO_MANY_SWATCHES' })]);
    expect(firstIssue([SWATCH_CSV_HEADER, ...rgbRows(MAX_SWATCHES + 1)].join('\n'))?.code).toBe('TOO_MANY_SWATCHES');
    const tooManyAndInvalid = new Uint8Array([...bytes(csv(...rgbRows(MAX_SWATCHES + 1))), 0xff]);
    expect(firstIssue(tooManyAndInvalid)?.code).toBe('TOO_MANY_SWATCHES');
  });

  it('accepts names of exactly MAX_SWATCH_NAME_LENGTH characters after unquoting and rejects one more', () => {
    const at = MAX_SWATCH_NAME_LENGTH;
    const over = MAX_SWATCH_NAME_LENGTH + 1;
    expect(swatchesOf(csv(`${'a'.repeat(at)},rgb,1,2,3,`))[0]?.name).toHaveLength(at);
    expect(issuesOf(csv(`${'a'.repeat(over)},rgb,1,2,3,`))).toEqual([expect.objectContaining({ code: 'NAME_TOO_LONG', line: 2 })]);
    expect(swatchesOf(csv(`"${'""'.repeat(at)}",rgb,1,2,3,`))[0]?.name).toBe('"'.repeat(at));
    expect(firstIssue(csv(`"${'""'.repeat(over)}",rgb,1,2,3,`))?.code).toBe('NAME_TOO_LONG');
    expect(swatchesOf(csv(`${'\u{1F600}'.repeat(at)},rgb,1,2,3,`))).toHaveLength(1);
    expect(firstIssue(csv(`${'\u{1F600}'.repeat(over)},rgb,1,2,3,`))?.code).toBe('NAME_TOO_LONG');
  });

  it('reports at most MAX_SWATCH_CSV_ISSUES issues, marking truncation', () => {
    const badRows = (count: number): string[] => Array.from({ length: count }, () => 'bad,cmyk,x,0,0,0');
    const exact = issuesOf(csv(...badRows(MAX_SWATCH_CSV_ISSUES)));
    expect(exact).toHaveLength(MAX_SWATCH_CSV_ISSUES);
    expect(exact.every((issue) => issue.code === 'BAD_NUMBER')).toBe(true);

    for (const count of [MAX_SWATCH_CSV_ISSUES + 1, 1000]) {
      const truncated = issuesOf(csv(...badRows(count)));
      expect(truncated).toHaveLength(MAX_SWATCH_CSV_ISSUES);
      expect(truncated.slice(0, -1).every((issue) => issue.code === 'BAD_NUMBER')).toBe(true);
      expect(truncated[MAX_SWATCH_CSV_ISSUES - 2]?.line).toBe(MAX_SWATCH_CSV_ISSUES);
      expect(truncated[MAX_SWATCH_CSV_ISSUES - 1]).toMatchObject({ code: 'TOO_MANY_ISSUES' });
    }
  });
});

describe('parseSwatchCsv: properties', () => {
  it('never throws on random bytes', () => {
    const rand = prng(0x032c);
    for (let run = 0; run < 500; run++) {
      const input = Uint8Array.from({ length: intIn(rand, 0, 300) }, () => intIn(rand, 0, 255));
      expectWellFormed(parseSwatchCsv(input));
    }
  });

  it('never throws on random CSV-like text', () => {
    const rand = prng(17);
    const tokens = [`${SWATCH_CSV_HEADER}\n`, 'a', '"', '""', ',', '\n', '\r\n', '\r', '0', '9', '.', '-', 'cmyk', 'lab', 'rgb', '\u{1F600}', '\u{FEFF}'];
    for (let run = 0; run < 500; run++) {
      const text = Array.from({ length: intIn(rand, 0, 80) }, () => pick(rand, tokens, ',')).join('');
      expectWellFormed(parseSwatchCsv(bytes(text)));
    }
  });

  it('never throws on mutated valid files', () => {
    const rand = prng(99);
    for (let run = 0; run < 300; run++) {
      const swatches = Array.from({ length: intIn(rand, 1, 8) }, (_, i) => randomSwatch(rand, i));
      const input = bytes(writeSwatchCsv(swatches));
      for (let edits = intIn(rand, 1, 4); edits > 0; edits--) input[intIn(rand, 0, input.length - 1)] = intIn(rand, 0, 255);
      expectWellFormed(parseSwatchCsv(input));
    }
  });

  it('round-trips random valid swatches through writeSwatchCsv', () => {
    const rand = prng(2026);
    for (let run = 0; run < 300; run++) {
      const swatches = Array.from({ length: intIn(rand, 0, 20) }, (_, i) => randomSwatch(rand, i));
      expect(parseSwatchCsv(bytes(writeSwatchCsv(swatches)))).toEqual({ ok: true, swatches });
    }
  });
});

describe('writeSwatchCsv', () => {
  it('writes the header, LF line endings and empty unused columns, quoting only names that need it', () => {
    const text = writeSwatchCsv([
      { name: 'Plain', space: 'rgb', values: [1, 2, 3] },
      { name: 'a,b', space: 'lab', values: [50, -1.5, 0] },
      { name: 'say "hi"', space: 'cmyk', values: [0, 10, 20.25, 100] },
    ]);
    expect(text).toBe(csv('Plain,rgb,1,2,3,', '"a,b",lab,50,-1.5,0,', '"say ""hi""",cmyk,0,10,20.25,100'));
  });

  it('writes tiny values and -0 without an exponent or sign', () => {
    const swatches: Swatch[] = [{ name: 'tiny', space: 'lab', values: [0.0000001, -0, 1e-21] }];
    const text = writeSwatchCsv(swatches);
    expect(text).toBe(csv('tiny,lab,0.0000001,0,0,'));
    expect(swatchesOf(text)[0]?.values).toEqual([1e-7, 0, 0]);
  });

  it('throws a RangeError for swatches the parser would reject', () => {
    const bad: Swatch[] = [
      { name: 'line\nbreak', space: 'rgb', values: [1, 2, 3] },
      { name: '', space: 'rgb', values: [1, 2, 3] },
      { name: 'x'.repeat(MAX_SWATCH_NAME_LENGTH + 1), space: 'rgb', values: [1, 2, 3] },
      { name: 'short', space: 'cmyk', values: [1, 2, 3] },
      { name: 'long', space: 'lab', values: [50, 0, 0, 0] },
      { name: 'range', space: 'rgb', values: [1, 2, 256] },
      { name: 'fraction', space: 'rgb', values: [1, 2, 2.5] },
      { name: 'nan', space: 'cmyk', values: [0, 0, 0, Number.NaN] },
    ];
    for (const swatch of bad) expect(() => writeSwatchCsv([swatch])).toThrow(RangeError);
  });
});

describe('swatchesToSpotLibrary', () => {
  it('turns lab swatches into spot colours and skips other spaces', () => {
    const swatches = swatchesOf(csv('Brand Red,lab,48,68,48,', 'Process,cmyk,0,90,85,5', 'Screen,rgb,1,2,3,', 'Harbor Blue,lab,38,5,-48,'));
    expect(swatchesToSpotLibrary(swatches, ' Brand ')).toEqual({
      name: 'Brand',
      colors: [
        { name: 'Brand Red', lab: { L: 48, a: 68, b: 48 } },
        { name: 'Harbor Blue', lab: { L: 38, a: 5, b: -48 } },
      ],
    });
  });

  it('rejects names that collide after spot-name normalisation, and an empty library name', () => {
    const swatches = swatchesOf(csv('Brand Red,lab,48,68,48,', 'brand  RED,lab,50,60,40,'));
    expect(() => swatchesToSpotLibrary(swatches, 'lib')).toThrow(ValidationError);
    expect(() => swatchesToSpotLibrary(swatches, 'lib')).toThrow(/duplicate spot color name brand {2}RED/);
    expect(() => swatchesToSpotLibrary([], '  ')).toThrow(ValidationError);
  });

  it('rejects a lab swatch with invalid values', () => {
    expect(() => swatchesToSpotLibrary([{ name: 'x', space: 'lab', values: [50, 0] }], 'lib')).toThrow(ValidationError);
  });
});
