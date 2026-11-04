import { describe, expect, it } from 'vitest';
import { CgatsParseError, cgatsNumber, cgatsRecords, parseCgats, serializeCgats } from '../src/index.js';

const SAMPLE = [
  'CGATS.17',
  'ORIGINATOR "test fixture"',
  'DESCRIPTOR "three patches"',
  'NUMBER_OF_FIELDS 4',
  'BEGIN_DATA_FORMAT',
  'SAMPLE_ID LAB_L LAB_A LAB_B',
  'END_DATA_FORMAT',
  'NUMBER_OF_SETS 3',
  'BEGIN_DATA',
  '1 95.12 -0.5 2.25',
  '2 50.0 60.125 -10',
  '3 12.5 0.001 0.75',
  'END_DATA',
  '',
].join('\n');

describe('CGATS.17', () => {
  it('parses header, fields and rows', () => {
    const doc = parseCgats(SAMPLE);
    expect(doc.identifier).toBe('CGATS.17');
    expect(doc.fields).toEqual(['SAMPLE_ID', 'LAB_L', 'LAB_A', 'LAB_B']);
    expect(doc.rows).toHaveLength(3);
    expect(doc.header).toContainEqual({ keyword: 'ORIGINATOR', value: 'test fixture' });
    expect(cgatsNumber(cgatsRecords(doc)[1]!, 'LAB_A')).toBeCloseTo(60.125, 9);
  });

  it('round-trips: parse → serialize → parse is stable and keeps numbers as text', () => {
    const first = parseCgats(SAMPLE);
    const text = serializeCgats(first);
    const second = parseCgats(text);
    expect(second).toEqual(first);
    expect(serializeCgats(second)).toBe(text);
    expect(second.rows[1]?.[1]).toBe('50.0');
  });

  it('accepts CRLF line ends and comments', () => {
    const text = SAMPLE.replace('ORIGINATOR', '# a comment\nORIGINATOR').replace(/\n/g, '\r\n');
    expect(parseCgats(text).rows).toEqual(parseCgats(SAMPLE).rows);
  });

  it('rejects a file without NUMBER_OF_SETS', () => {
    const text = SAMPLE.replace('NUMBER_OF_SETS 3\n', '');
    expect(() => parseCgats(text)).toThrow(CgatsParseError);
    expect(() => parseCgats(text)).toThrow(/NUMBER_OF_SETS/);
  });

  it('rejects a NUMBER_OF_SETS that disagrees with the data', () => {
    expect(() => parseCgats(SAMPLE.replace('NUMBER_OF_SETS 3', 'NUMBER_OF_SETS 4'))).toThrow(CgatsParseError);
  });

  it('rejects a row whose value count differs from the field count', () => {
    const text = SAMPLE.replace('2 50.0 60.125 -10', '2 50.0 60.125');
    expect(() => parseCgats(text)).toThrow(CgatsParseError);
    expect(() => parseCgats(text)).toThrow(/expected 4 values, found 3/);
  });

  it('rejects a NUMBER_OF_FIELDS that disagrees with the data format', () => {
    expect(() => parseCgats(SAMPLE.replace('NUMBER_OF_FIELDS 4', 'NUMBER_OF_FIELDS 5'))).toThrow(CgatsParseError);
  });

  it('refuses to serialize a row with the wrong length', () => {
    const doc = parseCgats(SAMPLE);
    expect(() => serializeCgats({ ...doc, rows: [...doc.rows, ['4', '1']] })).toThrow(CgatsParseError);
  });
});
