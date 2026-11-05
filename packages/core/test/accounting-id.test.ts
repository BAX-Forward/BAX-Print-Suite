import { describe, expect, it } from 'vitest';
import {
  groupAccountingByAccountingId,
  InvalidArgumentError,
  parseAccountingId,
  type AccountingJob,
  type AccountingQuantity,
  type DeviceAccountingReport,
} from '../src/index.js';

function report(jobId: string, quantities: DeviceAccountingReport['quantities']): DeviceAccountingReport {
  return { jobId, deviceId: 'device-1', reportedAt: '2026-11-05T10:00:00Z', quantities };
}

describe('parseAccountingId', () => {
  it('accepts letters, digits, space and - _ . /', () => {
    expect(parseAccountingId('CC-100_a.b/c 9')).toBe('CC-100_a.b/c 9');
  });

  it('trims surrounding whitespace', () => {
    expect(parseAccountingId('  ACME/42 \t')).toBe('ACME/42');
  });

  it('accepts exactly 64 characters and rejects 65', () => {
    expect(parseAccountingId('a'.repeat(64))).toBe('a'.repeat(64));
    expect(() => parseAccountingId('a'.repeat(65))).toThrow(InvalidArgumentError);
  });

  it('measures the length after trimming', () => {
    expect(parseAccountingId(` ${'a'.repeat(64)} `)).toBe('a'.repeat(64));
  });

  it('rejects empty and whitespace-only values', () => {
    expect(() => parseAccountingId('')).toThrow(InvalidArgumentError);
    expect(() => parseAccountingId('   ')).toThrow(InvalidArgumentError);
  });

  it.each(['a,b', 'a\tb', 'a\nb', 'café', 'a#1', 'a:b', 'a\\b'])('rejects disallowed characters in %j', (value) => {
    expect(() => parseAccountingId(value)).toThrow(/only letters, digits/);
  });

  it('rejects non-string values', () => {
    expect(() => parseAccountingId(42)).toThrow(InvalidArgumentError);
    expect(() => parseAccountingId(null)).toThrow(InvalidArgumentError);
  });
});

describe('groupAccountingByAccountingId', () => {
  const jobs: AccountingJob[] = [
    { id: 'job-a', ticket: { accountingId: 'ACME' } },
    { id: 'job-b', ticket: { accountingId: 'ACME' } },
    { id: 'job-c', ticket: { accountingId: 'CC-7' } },
    { id: 'job-d', ticket: {} },
  ];

  it('sums quantities with the same kind, name and unit per accounting ID', () => {
    const groups = groupAccountingByAccountingId(
      [
        report('job-a', [{ kind: 'ink', name: 'cyan', value: 1.5, unit: 'ml' }]),
        report('job-b', [
          { kind: 'ink', name: 'cyan', value: 2, unit: 'ml' },
          { kind: 'media', name: 'roll', value: 3, unit: 'm2' },
        ]),
        report('job-c', [{ kind: 'ink', name: 'cyan', value: 10, unit: 'ml' }]),
      ],
      jobs,
    );
    expect(groups).toEqual([
      {
        accountingId: 'ACME',
        jobIds: ['job-a', 'job-b'],
        quantities: [
          { kind: 'ink', name: 'cyan', value: 3.5, unit: 'ml' },
          { kind: 'media', name: 'roll', value: 3, unit: 'm2' },
        ],
      },
      { accountingId: 'CC-7', jobIds: ['job-c'], quantities: [{ kind: 'ink', name: 'cyan', value: 10, unit: 'ml' }] },
    ]);
  });

  it('never converts units and keeps different kinds and names apart', () => {
    const [group] = groupAccountingByAccountingId(
      [
        report('job-a', [
          { kind: 'ink', name: 'cyan', value: 1, unit: 'ml' },
          { kind: 'ink', name: 'cyan', value: 1, unit: 'l' },
          { kind: 'other', name: 'cyan', value: 1, unit: 'ml' },
          { kind: 'ink', name: 'magenta', value: 1, unit: 'ml' },
        ]),
      ],
      jobs,
    );
    expect(group?.quantities).toHaveLength(4);
  });

  it('groups jobs without an accounting ID and unknown jobs under null, listed last', () => {
    const groups = groupAccountingByAccountingId(
      [
        report('job-d', [{ kind: 'media', name: 'roll', value: 1, unit: 'm' }]),
        report('job-unknown', [{ kind: 'media', name: 'roll', value: 2, unit: 'm' }]),
        report('job-c', [{ kind: 'media', name: 'roll', value: 4, unit: 'm' }]),
      ],
      jobs,
    );
    expect(groups.map((g) => g.accountingId)).toEqual(['CC-7', null]);
    expect(groups[1]).toEqual({
      accountingId: null,
      jobIds: ['job-d', 'job-unknown'],
      quantities: [{ kind: 'media', name: 'roll', value: 3, unit: 'm' }],
    });
  });

  it('orders groups by accounting ID', () => {
    const groups = groupAccountingByAccountingId([report('job-c', []), report('job-a', [])], jobs);
    expect(groups.map((g) => g.accountingId)).toEqual(['ACME', 'CC-7']);
  });

  it('treats a stored ID with surrounding whitespace as the trimmed ID', () => {
    const groups = groupAccountingByAccountingId(
      [report('job-a', []), report('job-x', [])],
      [jobs[0] ?? { id: 'job-a', ticket: {} }, { id: 'job-x', ticket: { accountingId: ' ACME ' } }],
    );
    expect(groups).toEqual([{ accountingId: 'ACME', jobIds: ['job-a', 'job-x'], quantities: [] }]);
  });

  it('rejects an invalid stored accounting ID', () => {
    expect(() => groupAccountingByAccountingId([], [{ id: 'job-x', ticket: { accountingId: 'bad,id' } }])).toThrow(
      InvalidArgumentError,
    );
  });

  it('rejects a job listed twice with different accounting IDs', () => {
    expect(() =>
      groupAccountingByAccountingId(
        [],
        [
          { id: 'job-a', ticket: { accountingId: 'ACME' } },
          { id: 'job-a', ticket: {} },
        ],
      ),
    ).toThrow(/different accounting IDs/);
  });

  it('does not modify the input reports', () => {
    const quantity: AccountingQuantity = { kind: 'ink', name: 'cyan', value: 1, unit: 'ml' };
    const reports = [report('job-a', [quantity]), report('job-b', [{ ...quantity, value: 2 }])];
    groupAccountingByAccountingId(reports, jobs);
    expect(quantity.value).toBe(1);
    expect(reports[1]?.quantities[0]?.value).toBe(2);
  });

  it('returns no groups for no reports', () => {
    expect(groupAccountingByAccountingId([], jobs)).toEqual([]);
  });
});
