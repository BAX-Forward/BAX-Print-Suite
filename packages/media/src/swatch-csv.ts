/**
 * Swatch-library CSV import (Spec 032c): a pure parser and a matching writer.
 *
 * Format:
 * - UTF-8, with an optional byte order mark. Invalid UTF-8 is rejected.
 * - Lines end with LF or CRLF; a CR anywhere else is rejected. The file may end with a line
 *   terminator; any other blank line is rejected. Fields cannot span lines.
 * - The first line is the header and must be exactly `name,space,v1,v2,v3,v4` (case-sensitive).
 * - Every following line is one swatch with exactly six comma-separated fields:
 *   - `name`: taken verbatim (no trimming), never empty. It may be quoted per RFC 4180: wrapped
 *     in double quotes, with `""` for a literal quote; a quoted name may contain commas but not
 *     line breaks, and the closing quote must end the field. An unquoted name must not contain
 *     a double quote. Names must be unique, compared exactly.
 *   - `space`: `cmyk`, `lab` or `rgb` (lower case).
 *   - `v1..v4`: unquoted decimal numbers matching `-?digits[.digits]` (no exponent, no leading
 *     `+`, no bare `.5` or `5.`). Per space:
 *     - `cmyk`: v1..v4 = C, M, Y, K in percent, each 0..100.
 *     - `lab`: v1 = L* 0..100, v2 = a* -128..127, v3 = b* -128..127 (CIELAB relative to D50);
 *       v4 must be empty.
 *     - `rgb`: v1..v3 = R, G, B, integers 0..255; v4 must be empty.
 * - A header with no rows is a valid, empty library.
 *
 * Caps, each checked before the work it guards: at most {@link MAX_SWATCH_CSV_BYTES} bytes
 * (checked before decoding), at most {@link MAX_SWATCHES} lines after the header (counted on the
 * raw bytes before decoding), and at most {@link MAX_SWATCH_NAME_LENGTH} Unicode code points per
 * name after unquoting (checked before the swatch is built). At most
 * {@link MAX_SWATCH_CSV_ISSUES} issues are reported; when there are more, the last reported
 * issue is `TOO_MANY_ISSUES` and parsing stops.
 */
import { ValidationError, normalizeSpotName } from '@bax-print/core';
import type { SpotColor, SpotLibrary } from './spot-library.js';

export const MAX_SWATCH_CSV_BYTES = 1024 * 1024;
export const MAX_SWATCHES = 4096;
export const MAX_SWATCH_NAME_LENGTH = 256;
export const MAX_SWATCH_CSV_ISSUES = 100;

export const SWATCH_CSV_HEADER = 'name,space,v1,v2,v3,v4';

export type SwatchSpace = 'cmyk' | 'lab' | 'rgb';

export interface Swatch {
  readonly name: string;
  readonly space: SwatchSpace;
  /** Four values for `cmyk`, three for `lab` and `rgb`. */
  readonly values: readonly number[];
}

export type SwatchCsvIssueCode =
  | 'INVALID_INPUT'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_SWATCHES'
  | 'INVALID_UTF8'
  | 'EMPTY_FILE'
  | 'BAD_HEADER'
  | 'BLANK_LINE'
  | 'STRAY_CR'
  | 'COLUMN_COUNT'
  | 'UNTERMINATED_QUOTE'
  | 'BAD_QUOTE'
  | 'EMPTY_NAME'
  | 'NAME_TOO_LONG'
  | 'DUPLICATE_NAME'
  | 'BAD_SPACE'
  | 'BAD_NUMBER'
  | 'OUT_OF_RANGE'
  | 'UNEXPECTED_VALUE'
  | 'TOO_MANY_ISSUES';

export interface SwatchCsvIssue {
  readonly code: SwatchCsvIssueCode;
  /** 1-based line number; absent for whole-file issues. */
  readonly line?: number;
  readonly message: string;
}

export type SwatchCsvResult =
  | { readonly ok: true; readonly swatches: Swatch[] }
  | { readonly ok: false; readonly issues: SwatchCsvIssue[] };

interface Problem {
  readonly code: SwatchCsvIssueCode;
  readonly message: string;
}

interface ValueRule {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly integer: boolean;
}

const VALUE_COLUMNS = 4;
const LF = 0x0a;
const NUMBER = /^-?\d+(?:\.\d+)?$/;

const percent = (label: string): ValueRule => ({ label, min: 0, max: 100, integer: false });
const channel = (label: string): ValueRule => ({ label, min: 0, max: 255, integer: true });

const RULES: Readonly<Record<SwatchSpace, readonly ValueRule[]>> = {
  cmyk: [percent('C'), percent('M'), percent('Y'), percent('K')],
  lab: [
    { label: 'L*', min: 0, max: 100, integer: false },
    { label: 'a*', min: -128, max: 127, integer: false },
    { label: 'b*', min: -128, max: 127, integer: false },
  ],
  rgb: [channel('R'), channel('G'), channel('B')],
};

function isSwatchSpace(text: string): text is SwatchSpace {
  return text === 'cmyk' || text === 'lab' || text === 'rgb';
}

function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

/** Lines after the header, counted on the raw bytes; a final line terminator is not a line. */
function dataLineCount(bytes: Uint8Array): number {
  let breaks = 0;
  for (const byte of bytes) if (byte === LF) breaks++;
  return bytes[bytes.length - 1] === LF ? breaks - 1 : breaks;
}

function nameProblem(name: string): Problem | undefined {
  if (name === '') return { code: 'EMPTY_NAME', message: 'the name is empty' };
  const length = codePointLength(name);
  if (length > MAX_SWATCH_NAME_LENGTH) {
    return { code: 'NAME_TOO_LONG', message: `the name has ${length} characters, more than ${MAX_SWATCH_NAME_LENGTH}` };
  }
  return undefined;
}

function valueProblem(rule: ValueRule, value: number): Problem | undefined {
  if (!Number.isFinite(value) || value < rule.min || value > rule.max) {
    return { code: 'OUT_OF_RANGE', message: `${rule.label} ${value} is outside ${rule.min}..${rule.max}` };
  }
  if (rule.integer && !Number.isInteger(value)) {
    return { code: 'OUT_OF_RANGE', message: `${rule.label} ${value} is not an integer` };
  }
  return undefined;
}

function readQuotedName(line: string): { name: string; end: number } | Problem {
  let name = '';
  let from = 1;
  for (;;) {
    const close = line.indexOf('"', from);
    if (close < 0) {
      return { code: 'UNTERMINATED_QUOTE', message: 'the quoted name has no closing quote on this line (names cannot contain line breaks)' };
    }
    name += line.slice(from, close);
    if (line[close + 1] !== '"') return { name, end: close + 1 };
    name += '"';
    from = close + 2;
  }
}

function splitRow(line: string): { name: string; rest: string[] } | Problem {
  let name: string;
  let end: number;
  if (line.startsWith('"')) {
    const quoted = readQuotedName(line);
    if ('code' in quoted) return quoted;
    ({ name, end } = quoted);
    if (end < line.length && line[end] !== ',') {
      return { code: 'BAD_QUOTE', message: 'unexpected text after the closing quote of the name' };
    }
  } else {
    const comma = line.indexOf(',');
    end = comma < 0 ? line.length : comma;
    name = line.slice(0, end);
    if (name.includes('"')) return { code: 'BAD_QUOTE', message: 'double quote inside an unquoted name; quote the whole name' };
  }
  const rest = end < line.length ? line.slice(end + 1).split(',') : [];
  return { name, rest };
}

function readValues(space: SwatchSpace, cells: readonly string[], problems: Problem[]): number[] {
  const rules = RULES[space];
  const values: number[] = [];
  for (let i = 0; i < VALUE_COLUMNS; i++) {
    const text = cells[i] ?? '';
    const column = `v${i + 1}`;
    const rule = rules[i];
    if (rule === undefined) {
      if (text !== '') problems.push({ code: 'UNEXPECTED_VALUE', message: `${column} must be empty for ${space}, got ${JSON.stringify(text)}` });
      continue;
    }
    if (!NUMBER.test(text)) {
      problems.push({ code: 'BAD_NUMBER', message: `${column} (${rule.label}) ${JSON.stringify(text)} is not a decimal number` });
      continue;
    }
    // `+ 0` turns -0 into 0.
    const value = Number(text) + 0;
    const problem = valueProblem(rule, value);
    if (problem) problems.push({ ...problem, message: `${column} ${problem.message}` });
    values.push(value);
  }
  return values;
}

function readRow(line: string): Swatch | Problem[] {
  if (line === '') return [{ code: 'BLANK_LINE', message: 'blank line' }];
  if (line.includes('\r')) return [{ code: 'STRAY_CR', message: 'carriage return not followed by a line feed' }];
  const row = splitRow(line);
  if ('code' in row) return [row];
  if (row.rest.length !== 1 + VALUE_COLUMNS) {
    return [{ code: 'COLUMN_COUNT', message: `expected ${2 + VALUE_COLUMNS} columns, found ${1 + row.rest.length}` }];
  }
  const problems: Problem[] = [];
  const named = nameProblem(row.name);
  if (named) problems.push(named);
  const [space = '', ...cells] = row.rest;
  if (!isSwatchSpace(space)) {
    problems.push({ code: 'BAD_SPACE', message: `space ${JSON.stringify(space)} is not cmyk, lab or rgb` });
    return problems;
  }
  const values = readValues(space, cells, problems);
  return problems.length > 0 ? problems : { name: row.name, space, values };
}

class IssueList {
  private readonly items: SwatchCsvIssue[] = [];

  get full(): boolean {
    return this.items.length > MAX_SWATCH_CSV_ISSUES;
  }

  get empty(): boolean {
    return this.items.length === 0;
  }

  add(problem: Problem, line?: number): void {
    if (this.full) return;
    this.items.push(line === undefined ? { ...problem } : { code: problem.code, line, message: problem.message });
  }

  result(): SwatchCsvResult {
    if (!this.full) return { ok: false, issues: [...this.items] };
    const kept = this.items.slice(0, MAX_SWATCH_CSV_ISSUES - 1);
    return {
      ok: false,
      issues: [...kept, { code: 'TOO_MANY_ISSUES', message: `more than ${MAX_SWATCH_CSV_ISSUES} issues; parsing stopped` }],
    };
  }
}

function failure(code: SwatchCsvIssueCode, message: string, line?: number): SwatchCsvResult {
  return { ok: false, issues: [line === undefined ? { code, message } : { code, line, message }] };
}

function decode(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Parses a swatch-library CSV file (format in the module doc). Never throws. */
export function parseSwatchCsv(bytes: Uint8Array): SwatchCsvResult {
  if (!(bytes instanceof Uint8Array)) return failure('INVALID_INPUT', 'input must be a Uint8Array');
  if (bytes.length > MAX_SWATCH_CSV_BYTES) {
    return failure('FILE_TOO_LARGE', `the file has ${bytes.length} bytes, more than ${MAX_SWATCH_CSV_BYTES}`);
  }
  const rowCount = dataLineCount(bytes);
  if (rowCount > MAX_SWATCHES) return failure('TOO_MANY_SWATCHES', `the file has ${rowCount} rows, more than ${MAX_SWATCHES}`);
  const text = decode(bytes);
  if (text === undefined) return failure('INVALID_UTF8', 'the file is not valid UTF-8');
  if (text === '') return failure('EMPTY_FILE', `the file is empty; expected the header ${SWATCH_CSV_HEADER}`);

  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const header = lines[0] ?? '';
  if ((header.endsWith('\r') ? header.slice(0, -1) : header) !== SWATCH_CSV_HEADER) {
    return failure('BAD_HEADER', `the first line must be exactly ${SWATCH_CSV_HEADER}`, 1);
  }

  const issues = new IssueList();
  const firstLine = new Map<string, number>();
  const swatches: Swatch[] = [];
  for (let index = 1; index < lines.length && !issues.full; index++) {
    const raw = lines[index] ?? '';
    const lineNo = index + 1;
    const row = readRow(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (Array.isArray(row)) {
      for (const problem of row) issues.add(problem, lineNo);
      continue;
    }
    const previous = firstLine.get(row.name);
    if (previous !== undefined) {
      issues.add({ code: 'DUPLICATE_NAME', message: `duplicate name ${JSON.stringify(row.name)} (first on line ${previous})` }, lineNo);
      continue;
    }
    firstLine.set(row.name, lineNo);
    swatches.push(row);
  }
  return issues.empty ? { ok: true, swatches } : issues.result();
}

function swatchProblem(swatch: Swatch): string | undefined {
  if (/[\r\n]/.test(swatch.name)) return 'the name contains a line break';
  const named = nameProblem(swatch.name);
  if (named) return named.message;
  if (!isSwatchSpace(swatch.space)) return `space ${JSON.stringify(swatch.space)} is not cmyk, lab or rgb`;
  const rules = RULES[swatch.space];
  if (swatch.values.length !== rules.length) return `${swatch.space} needs ${rules.length} values, got ${swatch.values.length}`;
  for (const [i, rule] of rules.entries()) {
    const problem = valueProblem(rule, swatch.values[i] ?? Number.NaN);
    if (problem) return problem.message;
  }
  return undefined;
}

function formatNumber(value: number): string {
  const text = String(value + 0);
  // Magnitudes below 1e-6 print with an exponent; write them with at most 20 decimals instead.
  return /e/i.test(text) ? value.toFixed(20).replace(/\.?0+$/, '') : text;
}

function formatName(name: string): string {
  return /[",]/.test(name) ? `"${name.replaceAll('"', '""')}"` : name;
}

/**
 * Writes swatches in the format read by {@link parseSwatchCsv}, LF line endings, no byte order
 * mark. Throws a RangeError for a swatch the parser would reject. Duplicate names and the
 * row cap are not checked here.
 */
export function writeSwatchCsv(swatches: readonly Swatch[]): string {
  const lines = [SWATCH_CSV_HEADER];
  for (const swatch of swatches) {
    const problem = swatchProblem(swatch);
    if (problem !== undefined) throw new RangeError(`writeSwatchCsv: swatch ${JSON.stringify(swatch.name)}: ${problem}`);
    const cells = Array.from({ length: VALUE_COLUMNS }, (_, i) => {
      const value = swatch.values[i];
      return value === undefined ? '' : formatNumber(value);
    });
    lines.push([formatName(swatch.name), swatch.space, ...cells].join(','));
  }
  return lines.map((line) => `${line}\n`).join('');
}

/**
 * The `lab` swatches as a spot library (CMYK and RGB swatches are skipped: a spot colour needs
 * a Lab value). Names must be unique after spot-name normalisation, which is stricter than the
 * exact comparison of the CSV parser.
 */
export function swatchesToSpotLibrary(swatches: readonly Swatch[], libraryName: string): SpotLibrary {
  const name = libraryName.trim();
  if (name === '') throw new ValidationError('Spot library: the library name is empty');
  const seen = new Map<string, string>();
  const colors: SpotColor[] = [];
  for (const swatch of swatches) {
    if (swatch.space !== 'lab') continue;
    const problem = swatchProblem(swatch);
    const [L, a, b] = swatch.values;
    if (problem !== undefined || L === undefined || a === undefined || b === undefined) {
      throw new ValidationError(`Swatch CSV: swatch ${swatch.name}: ${problem ?? 'missing Lab values'}`, { object: swatch.name });
    }
    const key = normalizeSpotName(swatch.name);
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new ValidationError(`Swatch CSV: duplicate spot color name ${swatch.name} (also ${previous})`, { object: swatch.name });
    }
    seen.set(key, swatch.name);
    colors.push({ name: swatch.name, lab: { L, a, b } });
  }
  return { name, colors };
}
