/**
 * Minimal SemVer 2.0.0 parsing and npm-style range matching, enough for interface negotiation
 * (`provides[].versions` such as ">=1.0 <2", "^1.2.0", "~2.1", "1.x || 2.x").
 * Hyphen ranges ("1.0 - 2.0") are not supported. `../stub.ts` keeps its simpler `satisfiesRange`.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

type Operator = '<' | '<=' | '>' | '>=' | '=';

interface Comparator {
  op: Operator;
  version: Version;
}

const VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PARTIAL_PATTERN =
  /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
const TOKEN_PATTERN = /^(<=|>=|<|>|=|\^|~)?(.+)$/;

export function parseSemver(value: string): Version | undefined {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export function isValidVersion(value: string): boolean {
  return parseSemver(value) !== undefined;
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSemver(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const result = compareIdentifiers(left, right);
    if (result !== 0) return result;
  }
  return 0;
}

function version(major: number, minor = 0, patch = 0): Version {
  return { major, minor, patch, prerelease: [] };
}

interface PartialVersion {
  major?: number;
  minor?: number;
  patch?: number;
  prerelease: string[];
}

function parsePartial(value: string): PartialVersion | undefined {
  const match = PARTIAL_PATTERN.exec(value);
  if (!match) {
    return undefined;
  }
  const part = (text: string | undefined): number | undefined =>
    text === undefined || /^[xX*]$/.test(text) ? undefined : Number(text);
  const major = part(match[1]);
  const minor = major === undefined ? undefined : part(match[2]);
  const patch = minor === undefined ? undefined : part(match[3]);
  return { major, minor, patch, prerelease: match[4] ? match[4].split('.') : [] };
}

function expand(op: string, partial: PartialVersion): Comparator[] {
  if (partial.major === undefined) {
    return []; // wildcard: matches everything
  }
  const { major } = partial;
  const lower: Version = {
    major,
    minor: partial.minor ?? 0,
    patch: partial.patch ?? 0,
    prerelease: partial.prerelease,
  };
  // Next version above a partial ("1" → 2.0.0, "1.2" → 1.3.0); undefined for full versions.
  const nextUp =
    partial.minor === undefined
      ? version(major + 1)
      : partial.patch === undefined
        ? version(major, partial.minor + 1)
        : undefined;
  switch (op) {
    case '>=':
      return [{ op: '>=', version: lower }];
    case '>':
      return nextUp ? [{ op: '>=', version: nextUp }] : [{ op: '>', version: lower }];
    case '<':
      return [{ op: '<', version: lower }];
    case '<=':
      return nextUp ? [{ op: '<', version: nextUp }] : [{ op: '<=', version: lower }];
    case '^': {
      let upper: Version;
      if (major > 0 || partial.minor === undefined) {
        upper = version(major + 1);
      } else if (partial.minor > 0 || partial.patch === undefined) {
        upper = version(0, partial.minor + 1);
      } else {
        upper = version(0, 0, (partial.patch ?? 0) + 1);
      }
      return [
        { op: '>=', version: lower },
        { op: '<', version: upper },
      ];
    }
    case '~': {
      const upper =
        partial.minor === undefined ? version(major + 1) : version(major, partial.minor + 1);
      return [
        { op: '>=', version: lower },
        { op: '<', version: upper },
      ];
    }
    default:
      return nextUp
        ? [
            { op: '>=', version: lower },
            { op: '<', version: nextUp },
          ]
        : [{ op: '=', version: lower }];
  }
}

/** Parses a range into alternatives (OR) of comparator sets (AND). Undefined when invalid. */
function parseRange(range: string): Comparator[][] | undefined {
  const alternatives: Comparator[][] = [];
  for (const alternative of range.split('||')) {
    const normalized = alternative.trim().replace(/(<=|>=|<|>|=|\^|~)\s+/g, '$1');
    const comparators: Comparator[] = [];
    if (normalized !== '') {
      for (const token of normalized.split(/\s+/)) {
        const match = TOKEN_PATTERN.exec(token);
        const target = match?.[2];
        const partial = target !== undefined ? parsePartial(target) : undefined;
        // A bare wildcard ("*", "x") matches everything; an operator needs a concrete major.
        if (!match || !partial || (match[1] !== undefined && partial.major === undefined)) {
          return undefined;
        }
        comparators.push(...expand(match[1] ?? '=', partial));
      }
    }
    alternatives.push(comparators);
  }
  return alternatives;
}

export function isValidRange(range: string): boolean {
  return range.trim() !== '' && parseRange(range) !== undefined;
}

function test(comparator: Comparator, candidate: Version): boolean {
  const result = compareSemver(candidate, comparator.version);
  switch (comparator.op) {
    case '<':
      return result < 0;
    case '<=':
      return result <= 0;
    case '>':
      return result > 0;
    case '>=':
      return result >= 0;
    case '=':
      return result === 0;
  }
}

/** True when `candidate` is a valid version inside `range`. Invalid input never satisfies. */
export function satisfies(candidate: string, range: string): boolean {
  const parsed = parseSemver(candidate);
  const alternatives = parseRange(range);
  if (!parsed || !alternatives) {
    return false;
  }
  return alternatives.some((comparators) => comparators.every((c) => test(c, parsed)));
}
