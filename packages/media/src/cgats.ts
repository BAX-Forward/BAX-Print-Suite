import { BpsError } from '@bax-print/core';

export class CgatsParseError extends BpsError {
  readonly line: number | undefined;

  constructor(message: string, line?: number) {
    super('cgats_parse_error', line === undefined ? message : `line ${line}: ${message}`, line === undefined ? {} : { details: { line } });
    this.line = line;
  }
}

export interface CgatsHeaderEntry {
  keyword: string;
  value: string;
}

/**
 * One CGATS.17 data table. `NUMBER_OF_FIELDS` and `NUMBER_OF_SETS` are derived on output and
 * not kept in `header`. Values are kept as text so numbers round-trip exactly.
 */
export interface CgatsDocument {
  identifier: string;
  header: CgatsHeaderEntry[];
  fields: string[];
  rows: string[][];
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

interface Token {
  text: string;
  quoted: boolean;
}

function tokenize(line: string, lineNo: number): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') {
      i++;
    } else if (ch === '#') {
      break;
    } else if (ch === '"') {
      const end = line.indexOf('"', i + 1);
      if (end < 0) throw new CgatsParseError('unterminated quoted string', lineNo);
      tokens.push({ text: line.slice(i + 1, end), quoted: true });
      i = end + 1;
    } else {
      let j = i;
      while (j < line.length && line[j] !== ' ' && line[j] !== '\t' && line[j] !== '#') j++;
      tokens.push({ text: line.slice(i, j), quoted: false });
      i = j;
    }
  }
  return tokens;
}

function parseCount(tokens: Token[], keyword: string, lineNo: number): number {
  const value = tokens[1]?.text ?? '';
  if (!/^\d+$/.test(value)) throw new CgatsParseError(`${keyword} must be a non-negative integer`, lineNo);
  return Number(value);
}

/** Parses the first data table of a CGATS.17 file. */
export function parseCgats(text: string): CgatsDocument {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let identifier: string | undefined;
  const header: CgatsHeaderEntry[] = [];
  const fields: string[] = [];
  const rows: string[][] = [];
  let numberOfFields: number | undefined;
  let numberOfSets: number | undefined;
  let state: 'header' | 'format' | 'afterFormat' | 'data' | 'done' = 'header';
  let sawFormat = false;

  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    const tokens = tokenize(line, lineNo);
    const first = tokens[0];
    if (first === undefined) continue;
    const keyword = first.quoted ? '' : first.text;

    if (identifier === undefined) {
      identifier = first.text;
      continue;
    }
    if (state === 'done') break;

    if (state === 'format') {
      if (keyword === 'END_DATA_FORMAT') {
        state = 'afterFormat';
        continue;
      }
      fields.push(...tokens.map((t) => t.text));
      continue;
    }
    if (state === 'data') {
      if (keyword === 'END_DATA') {
        state = 'done';
        continue;
      }
      if (tokens.length !== fields.length) {
        throw new CgatsParseError(`expected ${fields.length} values, found ${tokens.length}`, lineNo);
      }
      rows.push(tokens.map((t) => t.text));
      continue;
    }

    switch (keyword) {
      case 'BEGIN_DATA_FORMAT':
        if (sawFormat) throw new CgatsParseError('duplicate BEGIN_DATA_FORMAT', lineNo);
        sawFormat = true;
        state = 'format';
        break;
      case 'NUMBER_OF_FIELDS':
        numberOfFields = parseCount(tokens, keyword, lineNo);
        break;
      case 'NUMBER_OF_SETS':
        numberOfSets = parseCount(tokens, keyword, lineNo);
        break;
      case 'BEGIN_DATA':
        if (!sawFormat || state !== 'afterFormat') throw new CgatsParseError('BEGIN_DATA before the data format', lineNo);
        if (numberOfSets === undefined) throw new CgatsParseError('NUMBER_OF_SETS is missing', lineNo);
        state = 'data';
        break;
      case 'END_DATA_FORMAT':
      case 'END_DATA':
        throw new CgatsParseError(`unexpected ${keyword}`, lineNo);
      default:
        if (first.quoted) throw new CgatsParseError('a header line must start with a keyword', lineNo);
        header.push({ keyword, value: tokens.slice(1).map((t) => t.text).join(' ') });
    }
  }

  if (identifier === undefined) throw new CgatsParseError('empty file');
  if (!sawFormat) throw new CgatsParseError('BEGIN_DATA_FORMAT is missing');
  if (state === 'format') throw new CgatsParseError('END_DATA_FORMAT is missing');
  if (numberOfSets === undefined) throw new CgatsParseError('NUMBER_OF_SETS is missing');
  if (state === 'afterFormat') throw new CgatsParseError('BEGIN_DATA is missing');
  if (state === 'data') throw new CgatsParseError('END_DATA is missing');
  if (fields.length === 0) throw new CgatsParseError('the data format declares no fields');
  if (new Set(fields).size !== fields.length) throw new CgatsParseError('duplicate field names in the data format');
  if (numberOfFields !== undefined && numberOfFields !== fields.length) {
    throw new CgatsParseError(`NUMBER_OF_FIELDS is ${numberOfFields} but the data format lists ${fields.length}`);
  }
  if (rows.length !== numberOfSets) {
    throw new CgatsParseError(`NUMBER_OF_SETS is ${numberOfSets} but the data has ${rows.length} sets`);
  }
  return { identifier, header, fields, rows };
}

function quote(value: string): string {
  if (value.includes('"')) throw new CgatsParseError('values may not contain double quotes');
  return NUMBER.test(value) ? value : `"${value}"`;
}

/** Canonical CGATS.17 text: non-numeric values quoted, single spaces, LF line ends. */
export function serializeCgats(doc: CgatsDocument): string {
  for (const row of doc.rows) {
    if (row.length !== doc.fields.length) throw new CgatsParseError('row length does not match the field count');
  }
  const lines = [doc.identifier];
  for (const entry of doc.header) lines.push(entry.value === '' ? entry.keyword : `${entry.keyword} ${quote(entry.value)}`);
  lines.push(`NUMBER_OF_FIELDS ${doc.fields.length}`, 'BEGIN_DATA_FORMAT', doc.fields.join(' '), 'END_DATA_FORMAT');
  lines.push(`NUMBER_OF_SETS ${doc.rows.length}`, 'BEGIN_DATA');
  for (const row of doc.rows) lines.push(row.map(quote).join(' '));
  lines.push('END_DATA');
  return `${lines.join('\n')}\n`;
}

export function cgatsHeaderValue(doc: CgatsDocument, keyword: string): string | undefined {
  return doc.header.find((entry) => entry.keyword === keyword)?.value;
}

/** Rows as field → text records. */
export function cgatsRecords(doc: CgatsDocument): Array<Record<string, string>> {
  return doc.rows.map((row) => Object.fromEntries(doc.fields.map((field, i) => [field, row[i]!])));
}

export function cgatsNumber(record: Record<string, string>, field: string): number {
  const text = record[field];
  if (text === undefined || !NUMBER.test(text)) throw new CgatsParseError(`field ${field} is not numeric: ${String(text)}`);
  return Number(text);
}

/** Formats a number for CGATS output with at most `digits` decimals and no exponent. */
export function formatCgatsNumber(value: number, digits = 6): string {
  const fixed = value.toFixed(digits);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return trimmed === '-0' ? '0' : trimmed;
}
