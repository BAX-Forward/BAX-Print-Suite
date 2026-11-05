import { beforeEach, describe, expect, it } from 'vitest';
import { unpack } from '@bax-print/archive';
import { InvalidArgumentError, type Actor } from '@bax-print/core';
import {
  AppendOnlyViolationError,
  historyForDevice,
  historyForJob,
  parseJsonl,
  type CloudEvent,
} from '@bax-print/events';
import { packageKey } from '@bax-print/store';
import { createServerHarness, DEVICE_A, MEDIUM_GLOSS, TICKET, type ServerHarness } from './helpers.js';

const OPERATOR: Actor = { id: 'op-7', role: 'operator' };
const JOB_ID = 'job-0001';
const JOB_SOURCE = '/bps/jobs';
const MINUTE = 60_000;

const ACCOUNTING = {
  jobId: JOB_ID,
  deviceId: DEVICE_A,
  reportedAt: '2026-03-01T09:30:00.000Z',
  quantities: [
    { kind: 'ink', name: 'cyan', value: 12.345, unit: 'ml' },
    { kind: 'ink', name: 'magenta', value: 0.5, unit: 'ml' },
    { kind: 'media', name: 'roll', value: 1.275, unit: 'm2' },
  ],
};

type Comparable = Omit<CloudEvent, 'id' | 'time'>;

function comparable(events: readonly CloudEvent[]): Comparable[] {
  return events.map(({ id: _id, time: _time, ...rest }) => rest);
}

function jobEvent(type: string, data: Record<string, unknown>): Comparable {
  return { specversion: '1.0', source: JOB_SOURCE, type, subject: JOB_ID, datacontenttype: 'application/json', data };
}

function statusChanged(from: string, to: string, actor = 'system'): Comparable {
  return jobEvent('job.status.changed', { jobId: JOB_ID, from, to, actor });
}

function step(phase: string, stage: string, details: Record<string, unknown> = {}): Comparable {
  return jobEvent(`step.${phase}`, { jobId: JOB_ID, stage, details });
}

/** Drives one job from intake to the archive, with steps, an operator action and an accounting report. */
async function scriptedLifecycle(h: ServerHarness): Promise<void> {
  const job = await h.jobs.create({
    name: 'Shop window',
    customerRef: 'C-1001',
    sources: [{ name: 'window.pdf', bytes: Buffer.from('%PDF-1.7 window') }],
    ticket: TICKET,
    deviceId: DEVICE_A,
    mediumId: MEDIUM_GLOSS,
  });
  expect(job.id).toBe(JOB_ID);

  await h.jobs.setStatus(JOB_ID, 'inspecting');
  await h.jobs.recordStep(JOB_ID, 'preflight', 'started');
  await h.jobs.recordStep(JOB_ID, 'preflight', 'completed', { warnings: 0 });
  await h.jobs.setStatus(JOB_ID, 'ready');
  await h.jobs.recordOperatorAction(JOB_ID, OPERATOR, 'approve-proof', { proof: 'v2' });
  await h.jobs.setStatus(JOB_ID, 'queued', OPERATOR);
  await h.jobs.setStatus(JOB_ID, 'processing');
  await h.jobs.recordStep(JOB_ID, 'render', 'started');
  await h.jobs.recordStep(JOB_ID, 'render', 'progress', { percent: 50 });
  await h.jobs.recordStep(JOB_ID, 'render', 'completed');
  await h.jobs.setStatus(JOB_ID, 'sent_to_device');
  h.time.advance(30 * MINUTE);
  await h.jobs.recordAccounting(ACCOUNTING);
  await h.jobs.setStatus(JOB_ID, 'printed');
  await h.jobs.setStatus(JOB_ID, 'done', OPERATOR);
  h.time.advance(MINUTE);
  await h.archive.archive(JOB_ID);
}

describe('production history of a scripted job lifecycle', () => {
  let h: ServerHarness;
  beforeEach(async () => {
    h = createServerHarness();
    await scriptedLifecycle(h);
  });

  it('equals the expected CloudEvents list, ignoring ids and times', async () => {
    const stat = await h.packages.stat(packageKey(JOB_ID));
    expect(stat).not.toBeNull();

    expect(comparable(historyForJob(h.outbox, JOB_ID))).toEqual([
      jobEvent('job.created', { jobId: JOB_ID, name: 'Shop window', status: 'received', actor: 'system' }),
      statusChanged('received', 'inspecting'),
      step('started', 'preflight'),
      step('completed', 'preflight', { warnings: 0 }),
      statusChanged('inspecting', 'ready'),
      jobEvent('operator.action', { jobId: JOB_ID, actor: 'op-7', action: 'approve-proof', details: { proof: 'v2' } }),
      statusChanged('ready', 'queued', 'op-7'),
      statusChanged('queued', 'processing'),
      step('started', 'render'),
      step('progress', 'render', { percent: 50 }),
      step('completed', 'render'),
      statusChanged('processing', 'sent_to_device'),
      {
        specversion: '1.0',
        source: '/bps/devices',
        type: 'device.accounting',
        subject: DEVICE_A,
        datacontenttype: 'application/json',
        data: ACCOUNTING,
      },
      statusChanged('sent_to_device', 'printed'),
      statusChanged('printed', 'done', 'op-7'),
      {
        specversion: '1.0',
        source: '/bps/archive',
        type: 'job.archived',
        subject: JOB_ID,
        datacontenttype: 'application/json',
        data: {
          jobId: JOB_ID,
          packageKey: packageKey(JOB_ID),
          packageSha256: stat?.sha256,
          actor: 'system',
          warnings: [],
        },
      },
    ]);
  });

  it('keeps events in outbox order with valid CloudEvents attributes and unique ids', () => {
    const events = historyForJob(h.outbox, JOB_ID);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    const times = events.map((e) => Date.parse(e.time));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(events.every((e) => e.specversion === '1.0' && e.datacontenttype === 'application/json')).toBe(true);
  });

  it('copies the history into history.jsonl of the job package', async () => {
    const pkg = unpack(await h.packages.get(packageKey(JOB_ID)));
    const events = historyForJob(h.outbox, JOB_ID);
    // job.archived is published once the package is safely stored, so it is the only event not in it.
    expect(events.at(-1)?.type).toBe('job.archived');
    expect(pkg.history).toEqual(events.slice(0, -1));

    const member = pkg.manifest.members.find((m) => m.role === 'history');
    expect(member?.path).toBe('history.jsonl');
  });

  it('stores device-reported usage exactly as reported, with units, in the device history', () => {
    const deviceHistory = historyForDevice(h.outbox, DEVICE_A);
    expect(deviceHistory).toHaveLength(1);
    const [report] = deviceHistory;
    if (!report) throw new Error('device history is empty');
    expect(report.type).toBe('device.accounting');
    expect(report.data).toEqual(ACCOUNTING);
    expect((report.data as typeof ACCOUNTING).quantities.map((q) => `${q.value} ${q.unit}`)).toEqual([
      '12.345 ml',
      '0.5 ml',
      '1.275 m2',
    ]);
  });
});

describe('append-only history', () => {
  let h: ServerHarness;
  beforeEach(async () => {
    h = createServerHarness();
    await scriptedLifecycle(h);
  });

  it('rejects attempts to update or delete a history row', () => {
    const [first] = h.outbox.list({ jobId: JOB_ID });
    if (!first) throw new Error('job has no history');
    const forged: CloudEvent = { ...first.event, data: { jobId: JOB_ID, name: 'Forged' } };

    expect(() => h.outbox.update(first.seq, forged)).toThrow(AppendOnlyViolationError);
    expect(() => h.outbox.delete(first.seq)).toThrow(AppendOnlyViolationError);
    expect(h.outbox.list({ jobId: JOB_ID })[0]).toEqual(first);
  });

  it('rejects re-appending an event id and in-place mutation of a stored row', () => {
    const [first] = h.outbox.list({ jobId: JOB_ID });
    if (!first) throw new Error('job has no history');
    expect(() => h.outbox.append({ ...first.event, data: { jobId: JOB_ID } })).toThrow(AppendOnlyViolationError);

    // Stored rows are deep-frozen; strict-mode assignment throws.
    expect(() => {
      (first.event as { type: string }).type = 'job.forged';
    }).toThrow(TypeError);
    expect(() => {
      (first.event.data as { name: string }).name = 'Forged';
    }).toThrow(TypeError);
    expect(h.outbox.list({ jobId: JOB_ID })[0]?.event.type).toBe('job.created');
  });

  it('records a correction as a new event that points at the corrected one', async () => {
    const before = historyForJob(h.outbox, JOB_ID);
    const target = before.find((e) => e.type === 'device.accounting') as CloudEvent;

    const correction = await h.jobs.recordCorrection(JOB_ID, target.id, 'cyan reading was doubled', OPERATOR, {
      quantities: [{ kind: 'ink', name: 'cyan', value: 6.1725, unit: 'ml' }],
    });

    const after = historyForJob(h.outbox, JOB_ID);
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, -1)).toEqual(before);
    expect(after.at(-1)).toEqual(correction);
    expect(correction.type).toBe('history.correction');
    expect(correction.data).toMatchObject({ jobId: JOB_ID, corrects: target.id, actor: 'op-7' });
    expect(after.find((e) => e.id === target.id)?.data).toEqual(ACCOUNTING);
  });

  it('serves the history as JSON Lines over HTTP', async () => {
    const response = await h.app.inject({ method: 'GET', url: `/jobs/${JOB_ID}/history` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    expect(parseJsonl(response.body)).toEqual(historyForJob(h.outbox, JOB_ID));
  });
});

describe('history input validation', () => {
  it('rejects malformed accounting reports and empty corrections without recording anything', async () => {
    const h = createServerHarness();
    await scriptedLifecycle(h);
    const count = h.outbox.list().length;

    await expect(
      h.jobs.recordAccounting({ ...ACCOUNTING, quantities: [{ kind: 'ink', name: 'cyan', value: 1 }] }),
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      h.jobs.recordAccounting({ ...ACCOUNTING, quantities: [{ kind: 'ink', name: 'cyan', value: Number.NaN, unit: 'ml' }] }),
    ).rejects.toThrow(InvalidArgumentError);
    await expect(h.jobs.recordAccounting({ ...ACCOUNTING, reportedAt: 'yesterday' })).rejects.toThrow(InvalidArgumentError);
    await expect(h.jobs.recordAccounting({ ...ACCOUNTING, jobId: 'job-9999' })).rejects.toThrow(/does not exist/);
    await expect(h.jobs.recordCorrection(JOB_ID, 'evt-0001', ' ', OPERATOR)).rejects.toThrow(InvalidArgumentError);

    expect(h.outbox.list()).toHaveLength(count);
  });
});
