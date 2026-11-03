import { describe, expect, it } from 'vitest';
import {
  createEvent,
  EventBus,
  InvalidEventError,
  MemoryOutbox,
  parseCloudEvent,
  parseJsonl,
  toJsonl,
  type CloudEvent,
} from '../src/index.js';

const NOW = new Date('2026-03-01T09:00:00.000Z');

function sampleEvent(id: string, data: Record<string, unknown> = { jobId: 'job-1' }): CloudEvent {
  return createEvent({ type: 'job.created', source: '/bps/jobs', subject: 'job-1', data }, id, NOW);
}

describe('CloudEvents 1.0 envelope', () => {
  it('creates a structured-mode event that parses back unchanged', () => {
    const event = sampleEvent('evt-1');
    expect(event).toEqual({
      specversion: '1.0',
      id: 'evt-1',
      source: '/bps/jobs',
      type: 'job.created',
      subject: 'job-1',
      time: NOW.toISOString(),
      datacontenttype: 'application/json',
      data: { jobId: 'job-1' },
    });
    expect(parseCloudEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it('rejects events with missing or invalid attributes', () => {
    const event = sampleEvent('evt-1');
    const invalid: unknown[] = [
      null,
      [],
      { ...event, specversion: '0.3' },
      { ...event, id: '' },
      { ...event, source: undefined },
      { ...event, time: 'yesterday' },
      { ...event, subject: 42 },
      { ...event, datacontenttype: 'text/plain' },
    ];
    for (const value of invalid) {
      expect(() => parseCloudEvent(value), JSON.stringify(value)).toThrow(InvalidEventError);
    }
  });
});

describe('JSON Lines history', () => {
  it('round-trips events one per line', () => {
    const events = [sampleEvent('evt-1'), sampleEvent('evt-2', { jobId: 'job-1', note: 'line\nbreak' })];
    const text = toJsonl(events);
    expect(text.split('\n')).toHaveLength(3);
    expect(parseJsonl(text)).toEqual(events);
  });

  it('skips blank lines and names the line that is not JSON', () => {
    expect(parseJsonl('\n\r\n')).toEqual([]);
    const text = `${JSON.stringify(sampleEvent('evt-1'))}\n{not json\n`;
    expect(() => parseJsonl(text)).toThrow(/line 2/);
  });
});

describe('EventBus', () => {
  it('writes to the outbox before listeners run and isolates listener failures', () => {
    const outbox = new MemoryOutbox();
    let next = 0;
    const failures: string[] = [];
    const bus = new EventBus(outbox, {
      clock: () => NOW,
      newId: () => `evt-${++next}`,
      onListenerError: (_error, event) => failures.push(event.id),
    });
    const seen: number[] = [];
    bus.subscribe(() => {
      throw new Error('listener broke');
    });
    const unsubscribe = bus.subscribe(() => seen.push(outbox.list().length));

    bus.publish({ type: 'job.created', source: '/bps/jobs', data: { jobId: 'job-1' } });
    unsubscribe();
    bus.publish({ type: 'job.status.changed', source: '/bps/jobs', data: { jobId: 'job-1' } });

    expect(seen).toEqual([1]);
    expect(failures).toEqual(['evt-1', 'evt-2']);
    expect(outbox.list({ jobId: 'job-1' }).map((r) => [r.seq, r.event.type])).toEqual([
      [1, 'job.created'],
      [2, 'job.status.changed'],
    ]);
  });

  it('filters the outbox by device, type and sequence', () => {
    const outbox = new MemoryOutbox();
    outbox.append(sampleEvent('evt-1'));
    outbox.append(
      createEvent({ type: 'device.accounting', source: '/bps/devices', data: { jobId: 'job-1', deviceId: 'dev-a' } }, 'evt-2', NOW),
    );
    expect(outbox.list({ deviceId: 'dev-a' }).map((r) => r.event.id)).toEqual(['evt-2']);
    expect(outbox.list({ types: ['job.created'] }).map((r) => r.event.id)).toEqual(['evt-1']);
    expect(outbox.list({ afterSeq: 1 }).map((r) => r.event.id)).toEqual(['evt-2']);
  });
});
