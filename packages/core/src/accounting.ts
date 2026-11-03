import { InvalidArgumentError } from './errors.js';

export type AccountingKind = 'ink' | 'media' | 'other';

const KINDS: readonly AccountingKind[] = ['ink', 'media', 'other'];

/** One quantity exactly as the device reported it. Units are never converted. */
export interface AccountingQuantity {
  readonly kind: AccountingKind;
  readonly name: string;
  readonly value: number;
  readonly unit: string;
}

export interface DeviceAccountingReport {
  readonly jobId: string;
  readonly deviceId: string;
  readonly reportedAt: string;
  readonly quantities: readonly AccountingQuantity[];
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidArgumentError(`accounting report: ${field} must be a non-empty string`);
  }
  return value;
}

function parseQuantity(value: unknown, index: number): AccountingQuantity {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidArgumentError(`accounting report: quantities[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (!KINDS.includes(record.kind as AccountingKind)) {
    throw new InvalidArgumentError(`accounting report: quantities[${index}].kind must be one of ${KINDS.join(', ')}`);
  }
  if (typeof record.value !== 'number' || !Number.isFinite(record.value)) {
    throw new InvalidArgumentError(`accounting report: quantities[${index}].value must be a finite number`);
  }
  return {
    kind: record.kind as AccountingKind,
    name: nonEmptyString(record.name, `quantities[${index}].name`),
    value: record.value,
    unit: nonEmptyString(record.unit, `quantities[${index}].unit`),
  };
}

/** Validates a device accounting report at the system boundary; values and units are kept as reported. */
export function validateAccountingReport(value: unknown): DeviceAccountingReport {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidArgumentError('accounting report must be an object');
  }
  const record = value as Record<string, unknown>;
  const reportedAt = nonEmptyString(record.reportedAt, 'reportedAt');
  if (Number.isNaN(Date.parse(reportedAt))) {
    throw new InvalidArgumentError('accounting report: reportedAt must be a date-time');
  }
  if (!Array.isArray(record.quantities)) {
    throw new InvalidArgumentError('accounting report: quantities must be an array');
  }
  return {
    jobId: nonEmptyString(record.jobId, 'jobId'),
    deviceId: nonEmptyString(record.deviceId, 'deviceId'),
    reportedAt,
    quantities: record.quantities.map(parseQuantity),
  };
}
