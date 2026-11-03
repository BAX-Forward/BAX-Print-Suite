import { BpsError } from '@bax-print/core';

/** CloudEvents 1.0 envelope (structured JSON mode). */
export interface CloudEvent<T = unknown> {
  readonly specversion: '1.0';
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly subject?: string;
  readonly time: string;
  readonly datacontenttype: 'application/json';
  readonly data: T;
}

export interface EventInput<T = unknown> {
  readonly type: string;
  readonly source: string;
  readonly subject?: string;
  readonly data: T;
}

export class InvalidEventError extends BpsError {
  constructor(message: string, options?: ErrorOptions) {
    super('INVALID_EVENT', message, options);
  }
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value === '') {
    throw new InvalidEventError(`CloudEvent attribute "${field}" must be a non-empty string`);
  }
  return value;
}

export function createEvent<T>(input: EventInput<T>, id: string, time: Date): CloudEvent<T> {
  if (!input.type || !input.source) {
    throw new InvalidEventError('CloudEvent needs a type and a source');
  }
  return {
    specversion: '1.0',
    id,
    source: input.source,
    type: input.type,
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    time: time.toISOString(),
    datacontenttype: 'application/json',
    data: input.data,
  };
}

/** Validates an untrusted value as a CloudEvent 1.0 produced by this project. */
export function parseCloudEvent(value: unknown): CloudEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidEventError('CloudEvent must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.specversion !== '1.0') {
    throw new InvalidEventError('CloudEvent specversion must be "1.0"');
  }
  const time = requireString(record, 'time');
  if (Number.isNaN(Date.parse(time))) {
    throw new InvalidEventError('CloudEvent time must be an RFC 3339 timestamp');
  }
  if (record.subject !== undefined && typeof record.subject !== 'string') {
    throw new InvalidEventError('CloudEvent subject must be a string');
  }
  if (record.datacontenttype !== 'application/json') {
    throw new InvalidEventError('CloudEvent datacontenttype must be application/json');
  }
  return {
    specversion: '1.0',
    id: requireString(record, 'id'),
    source: requireString(record, 'source'),
    type: requireString(record, 'type'),
    ...(record.subject === undefined ? {} : { subject: record.subject as string }),
    time,
    datacontenttype: 'application/json',
    data: record.data,
  };
}
