import { InvalidEventError, parseCloudEvent, type CloudEvent } from './cloudevent.js';
import type { Outbox } from './outbox.js';

/** All events about one job, in outbox order. */
export function historyForJob(outbox: Outbox, jobId: string): CloudEvent[] {
  return outbox.list({ jobId }).map((record) => record.event);
}

/** All events reported for or about one device, in outbox order. */
export function historyForDevice(outbox: Outbox, deviceId: string): CloudEvent[] {
  return outbox.list({ deviceId }).map((record) => record.event);
}

/** Serializes events as JSON Lines (one CloudEvent per line). */
export function toJsonl(events: readonly CloudEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join('');
}

export function parseJsonl(text: string): CloudEvent[] {
  const events: CloudEvent[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new InvalidEventError(`history line ${index + 1} is not valid JSON`, { cause: error });
    }
    events.push(parseCloudEvent(value));
  }
  return events;
}
