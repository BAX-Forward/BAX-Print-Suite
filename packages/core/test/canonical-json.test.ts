import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type ColorSetupContent, canonicalContentHash, canonicalJson, newId } from '../src/index.js';

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined members', () => {
    const a = canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } });
    const b = canonicalJson({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(TypeError);
  });
});

describe('canonicalContentHash', () => {
  const content: ColorSetupContent = {
    level: 'L3',
    renderingIntent: 'relative-colorimetric',
    tacLimitPercent: 300,
    channelLimitsPercent: { c: 95, m: 90 },
    curves: { metric: 'de2000-from-paper', inputs: [0, 0.5, 1], channels: { c: [0, 0.42, 1] } },
  };
  // Deliberately untyped so the explicit `undefined` member is allowed under any tsconfig.
  const reordered = {
    curves: { channels: { c: [0, 0.42, 1] }, inputs: [0, 0.5, 1], metric: 'de2000-from-paper' },
    channelLimitsPercent: { m: 90, c: 95 },
    tacLimitPercent: 300,
    renderingIntent: 'relative-colorimetric',
    level: 'L3',
    outputProfile: undefined,
  };
  const pinnedJson =
    '{"channelLimitsPercent":{"c":95,"m":90},"curves":{"channels":{"c":[0,0.42,1]},"inputs":[0,0.5,1],' +
    '"metric":"de2000-from-paper"},"level":"L3","renderingIntent":"relative-colorimetric","tacLimitPercent":300}';

  it('is the SHA-256 of the pinned canonical form', () => {
    expect(canonicalJson(content)).toBe(pinnedJson);
    const expected = createHash('sha256').update(pinnedJson, 'utf8').digest('hex');
    expect(canonicalContentHash(content)).toBe(expected);
    expect(canonicalContentHash(content)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across key order, undefined members and repeated calls', () => {
    expect(canonicalContentHash(reordered)).toBe(canonicalContentHash(content));
    expect(canonicalContentHash(content)).toBe(canonicalContentHash(structuredClone(content)));
  });

  it('changes when the content changes', () => {
    expect(canonicalContentHash({ ...content, tacLimitPercent: 280 })).not.toBe(canonicalContentHash(content));
    expect(canonicalContentHash([1, 2])).not.toBe(canonicalContentHash([2, 1]));
  });
});

describe('newId', () => {
  it('produces 26-character ULIDs ordered by time', () => {
    const first = newId(1_000);
    const second = newId(2_000);
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first.slice(0, 10) < second.slice(0, 10)).toBe(true);
  });
});
