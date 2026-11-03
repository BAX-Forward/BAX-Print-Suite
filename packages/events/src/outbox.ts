import { BpsError } from '@bax-print/core';
import { parseCloudEvent, type CloudEvent } from './cloudevent.js';

export interface OutboxRecord {
  readonly seq: number;
  readonly event: CloudEvent;
}

export interface OutboxQuery {
  /** Matches events whose `data.jobId` equals this id. */
  readonly jobId?: string;
  /** Matches events whose `data.deviceId` equals this id. */
  readonly deviceId?: string;
  readonly types?: readonly string[];
  readonly afterSeq?: number;
}

/**
 * Append-only event store. Rows are never changed or removed: a correction is a new event.
 * `update` and `delete` exist so callers get a typed rejection instead of a silent no-op.
 */
export interface Outbox {
  append(event: CloudEvent): OutboxRecord;
  list(query?: OutboxQuery): readonly OutboxRecord[];
  update(seq: number, event: CloudEvent): never;
  delete(seq: number): never;
}

export class AppendOnlyViolationError extends BpsError {
  constructor(message: string) {
    super('APPEND_ONLY', message);
  }
}

function dataField(event: CloudEvent, field: string): unknown {
  const data = event.data;
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  return (data as Record<string, unknown>)[field];
}

export function eventJobId(event: CloudEvent): string | undefined {
  const value = dataField(event, 'jobId');
  return typeof value === 'string' ? value : undefined;
}

export function eventDeviceId(event: CloudEvent): string | undefined {
  const value = dataField(event, 'deviceId');
  return typeof value === 'string' ? value : undefined;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export function matchesQuery(record: OutboxRecord, query: OutboxQuery): boolean {
  if (query.afterSeq !== undefined && record.seq <= query.afterSeq) return false;
  if (query.types !== undefined && !query.types.includes(record.event.type)) return false;
  if (query.jobId !== undefined && eventJobId(record.event) !== query.jobId) return false;
  if (query.deviceId !== undefined && eventDeviceId(record.event) !== query.deviceId) return false;
  return true;
}

/** In-process outbox for single-PC mode and tests. Records are deep-frozen copies. */
export class MemoryOutbox implements Outbox {
  private readonly records: OutboxRecord[] = [];
  private readonly ids = new Set<string>();

  append(event: CloudEvent): OutboxRecord {
    const parsed = parseCloudEvent(event);
    if (this.ids.has(parsed.id)) {
      throw new AppendOnlyViolationError(`event ${parsed.id} is already recorded; a correction must be a new event`);
    }
    const record = deepFreeze({ seq: this.records.length + 1, event: structuredClone(parsed) });
    this.records.push(record);
    this.ids.add(parsed.id);
    return record;
  }

  list(query: OutboxQuery = {}): readonly OutboxRecord[] {
    return this.records.filter((record) => matchesQuery(record, query));
  }

  update(seq: number): never {
    throw new AppendOnlyViolationError(`history row ${seq} is append-only; record a correction as a new event`);
  }

  delete(seq: number): never {
    throw new AppendOnlyViolationError(`history row ${seq} is append-only and cannot be deleted`);
  }
}
