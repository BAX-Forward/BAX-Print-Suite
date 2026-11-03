import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEVICE_IDS, fixtureId } from '../mock/fixtures';
import type { MockDb } from '../mock/db';
import { MAX_THUMBNAIL_PX } from '../src/preview/types';
import { strings } from '../src/strings';
import { createFakeRenderer, installMockServer, renderApp, useMockDb, waitForLive } from './helpers';

/** Spec 002 Part B, screens 2–3 (Job detail and actions) against the MSW mock API. */

const t = strings.jobDetail;
const READY_JOB = fixtureId(7); // brochure-a4-3pages: 3 trimmed A4 pages
const DELIVERED_JOB = fixtureId(3); // banner-3000x1000-sale, sent_to_device
const FAILED_JOB = fixtureId(5); // trade-show-backwall, failed in output
const HELD_JOB = fixtureId(10);

installMockServer();

async function renderJob(jobId: string, db: MockDb = useMockDb(), renderer = createFakeRenderer()) {
  const view = renderApp(`/jobs/${jobId}`, db, renderer.renderer);
  await screen.findByRole('heading', { level: 1, name: db.getJob(jobId).name });
  return { db, calls: renderer.calls, ...view };
}

const region = (name: string) => within(screen.getByRole('region', { name }));
const statusButton = (name: string | undefined) =>
  within(screen.getByRole('group', { name: t.statusActions })).getByRole('button', { name });

describe('Metadata, pages and preview', () => {
  it('shows the job metadata', async () => {
    const { db } = await renderJob(READY_JOB);
    const job = db.getJob(READY_JOB);
    const details = region(t.detailsHeading);
    expect(details.getByText(job.id)).toBeInTheDocument();
    expect(details.getByText(job.sha256)).toBeInTheDocument();
    expect(details.getByText(strings.status.ready)).toBeInTheDocument();
    // The hot folder name comes from a separate query; the raw ID is shown until it resolves.
    expect(await details.findByText('Posters')).toBeInTheDocument();
    expect(details.getByText('4.3 MB')).toBeInTheDocument();
    expect(details.getByText(job.sourcePath ?? '')).toBeInTheDocument();
  });

  it('lists pages with size and trim box, in inches or millimetres', async () => {
    const { user } = await renderJob(READY_JOB);
    const pages = within(screen.getByRole('table', { name: t.pagesCaption }));
    expect(pages.getAllByRole('row')).toHaveLength(4); // header + 3 pages
    expect(pages.getAllByText('8.5 × 11.93 in')).toHaveLength(3);
    expect(pages.getAllByText('8.27 × 11.69 in at 0.12, 0.12')).toHaveLength(3);

    await user.click(screen.getByRole('radio', { name: strings.common.millimetres }));
    expect(pages.getAllByText('216 × 303 mm')).toHaveLength(3);
    expect(pages.getAllByText('210 × 297 mm at 3, 3')).toHaveLength(3);
  });

  it('renders one labeled screen-preview thumbnail per page, capped at 320 px', async () => {
    const { calls } = await renderJob(READY_JOB);
    const thumbnails = await screen.findAllByRole('img', { name: /^Screen preview of page \d$/ });
    expect(thumbnails.map((canvas) => canvas.getAttribute('aria-label'))).toEqual([1, 2, 3].map((n) => t.screenPreviewOf(n)));
    expect(calls.map((call) => call.pageIndex).sort()).toEqual([0, 1, 2]);
    expect(calls.every((call) => call.jobId === READY_JOB && call.maxPx === MAX_THUMBNAIL_PX)).toBe(true);
    expect(screen.getByText(`${t.screenPreview} · ${t.page} 1`)).toBeInTheDocument();
    expect(screen.getByText(t.previewNote)).toBeInTheDocument();
  });

  it('shows "Preview unavailable" when rendering fails', async () => {
    const failing = { renderer: { render: () => Promise.reject(new Error('broken PDF')) }, calls: [] };
    await renderJob(READY_JOB, useMockDb(), failing);
    expect(await screen.findAllByText(t.previewFailed)).toHaveLength(3);
  });
});

describe('Timeline and errors', () => {
  it('merges steps and audit entries, oldest first, with the delivery result', async () => {
    const { db } = await renderJob(DELIVERED_JOB);
    const items = within(screen.getByRole('region', { name: t.timelineHeading })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(t.step('intake'));
    expect(items.some((item) => item.dataset.kind === 'audit')).toBe(true);

    const output = items.find((item) => item.textContent?.includes(t.step('output')));
    const path = `/srv/rip/in/roll-a/banner-3000x1000-sale_${DELIVERED_JOB}.pdf`;
    expect(output).toHaveTextContent(path);
    expect(output).toHaveTextContent(db.getJob(DELIVERED_JOB).sha256);
    expect(region(t.detailsHeading).getByText(path)).toBeInTheDocument();
  });

  it('shows the error panel for failed jobs and disables every action', async () => {
    await renderJob(FAILED_JOB);
    const panel = region(t.errorHeading);
    expect(panel.getByText('The target folder is not writable.')).toBeInTheDocument();
    expect(panel.getByText('DELIVERY_FAILED')).toBeInTheDocument();
    expect(panel.getByText('Permission denied after 3 attempts.')).toBeInTheDocument();

    await waitFor(() => expect(within(screen.getByRole('group', { name: t.statusActions })).getAllByRole('button').every((b) => b.hasAttribute('disabled'))).toBe(true));
    expect(screen.getByRole('button', { name: t.sendToDevice })).toBeDisabled();
  });

  it('shows no error panel for healthy jobs', async () => {
    await renderJob(READY_JOB);
    expect(screen.queryByRole('region', { name: t.errorHeading })).not.toBeInTheDocument();
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
    expect(db.getTransitions(HELD_JOB).allowed).toEqual(['queued', 'failed', 'cancelled']);
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

  it('sends a job to a device, shows the delivered path and marks it done', async () => {
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
    const path = `/srv/rip/in/roll-a/brochure-a4-3pages_${READY_JOB}.pdf`;
    await waitFor(() => expect(details.getByText(path)).toBeInTheDocument());

    await waitFor(() => expect(statusButton(t.actions.done)).toBeEnabled());
    await user.click(statusButton(t.actions.done));
    await waitFor(() => expect(db.getJob(READY_JOB).status).toBe('done'));
    await waitFor(() => expect(details.getByText(strings.status.done)).toBeInTheDocument());
  });
});
