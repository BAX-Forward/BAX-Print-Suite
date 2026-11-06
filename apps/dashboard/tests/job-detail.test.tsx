import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEVICE_IDS, fixtureId } from '../mock/fixtures';
import type { MockDb } from '../mock/db';
import { formatBytes } from '../src/lib/format';
import { strings } from '../src/strings';
import { installMockServer, renderApp, useMockDb, waitForLive } from './helpers';

/**
 * Spec 002 Part B, screens 2–3 (Job detail and actions) against the MSW mock API. The details are
 * the 052a Job's fields (GET /jobs/:id); the actions use the mock-only PATCH, print and transitions.
 */

const t = strings.jobDetail;
const READY_JOB = fixtureId(7); // brochure-a4-3pages
const HELD_JOB = fixtureId(10);

installMockServer();

async function renderJob(jobId: string, db: MockDb = useMockDb()) {
  const view = renderApp(`/jobs/${jobId}`, db);
  await screen.findByRole('heading', { level: 1, name: db.readJob(jobId).name });
  return { db, ...view };
}

const region = (name: string) => within(screen.getByRole('region', { name }));
const statusButton = (name: string | undefined) =>
  within(screen.getByRole('group', { name: t.statusActions })).getByRole('button', { name });

describe('Metadata', () => {
  it('shows the fields of the 052a job', async () => {
    const { db } = await renderJob(READY_JOB);
    const job = db.readJob(READY_JOB);
    const source = job.sourceFiles[0];
    if (!source) throw new Error('The fixture job has no source file');
    const details = region(t.detailsHeading);
    expect(details.getByText(job.id)).toBeInTheDocument();
    expect(details.getByText(strings.status.ready)).toBeInTheDocument();
    expect(details.getByText(source.name)).toBeInTheDocument();
    expect(details.getByText(source.sha256)).toBeInTheDocument();
    expect(details.getByText(formatBytes(source.sizeBytes))).toBeInTheDocument();
    expect(details.getByText('pdf')).toBeInTheDocument();
    expect(details.getByText('active')).toBeInTheDocument();
  });

  it('reports unknown jobs', async () => {
    renderApp('/jobs/does-not-exist', useMockDb());
    expect(await screen.findByRole('heading', { level: 1, name: t.notFound })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: strings.common.backToJobs })).toHaveAttribute('href', '/jobs');
  });
});

describe('Actions', () => {
  it('enables only the transitions GET /transitions allows', async () => {
    const { db } = await renderJob(HELD_JOB);
    expect(db.getTransitions(HELD_JOB).allowed).toEqual(['ready', 'queued', 'failed', 'cancelled']);
    await waitFor(() => expect(statusButton(t.actions.queued)).toBeEnabled());
    expect(statusButton(t.actions.cancelled)).toBeEnabled();
    expect(statusButton(t.actions.held)).toBeDisabled();
    expect(statusButton(t.actions.printed)).toBeDisabled();
    expect(statusButton(t.actions.done)).toBeDisabled();
  });

  it('holds and then queues a job', async () => {
    const { user, db } = await renderJob(READY_JOB);
    await waitFor(() => expect(statusButton(t.actions.held)).toBeEnabled());
    await user.click(statusButton(t.actions.held));
    await screen.findByText(t.statusChanged(strings.status.held));
    expect(db.getJob(READY_JOB).status).toBe('held');

    await waitFor(() => expect(statusButton(t.actions.held)).toBeDisabled());
    await waitFor(() => expect(statusButton(t.actions.queued)).toBeEnabled());
    await user.click(statusButton(t.actions.queued));
    await waitFor(() => expect(db.getJob(READY_JOB).status).toBe('queued'));
    await waitFor(() => expect(region(t.detailsHeading).getByText(strings.status.queued)).toBeInTheDocument());
  });

  it('sets the priority (0–100) with the number field', async () => {
    const { user, db } = await renderJob(READY_JOB);
    const save = within(screen.getByRole('region', { name: t.actionsHeading })).getByRole('button', { name: t.setPriority });
    expect(save).toBeDisabled();
    const input = screen.getByRole('spinbutton', { name: t.priorityLabel });
    await user.clear(input);
    await user.type(input, '250');
    expect(input).toHaveValue(100); // clamped
    expect(screen.getByRole('slider', { name: t.prioritySlider })).toHaveValue('100');

    await user.clear(input);
    await user.type(input, '90');
    await user.click(screen.getByRole('button', { name: t.setPriority }));
    await screen.findByText(t.priorityChanged(90));
    expect(db.getJob(READY_JOB).priority).toBe(90);
  });

  it('sends a job to a device and marks it done', async () => {
    const { user, db } = await renderJob(READY_JOB);
    await waitForLive();
    const actions = region(t.actionsHeading);
    const send = actions.getByRole('button', { name: t.sendToDevice });
    expect(send).toBeDisabled(); // no device chosen yet

    await user.selectOptions(actions.getByRole('combobox', { name: t.device }), 'Roll printer A');
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await screen.findByText(t.sentToDevice('Roll printer A'));

    await waitFor(() => expect(db.getJob(READY_JOB).status).toBe('sent_to_device'));
    expect(db.getJob(READY_JOB).deviceId).toBe(DEVICE_IDS.rollA);
    const details = region(t.detailsHeading);
    await waitFor(() => expect(details.getByText(strings.status.sent_to_device)).toBeInTheDocument());

    await waitFor(() => expect(statusButton(t.actions.done)).toBeEnabled());
    await user.click(statusButton(t.actions.done));
    await waitFor(() => expect(db.getJob(READY_JOB).status).toBe('done'));
    await waitFor(() => expect(details.getByText(strings.status.done)).toBeInTheDocument());
  });
});
