import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fixtureId, HOT_FOLDER_IDS } from '../mock/fixtures';
import { JOBS_PAGE_SIZE } from '../src/api/queries';
import { VIRTUALIZE_THRESHOLD } from '../src/pages/JobsPage';
import { strings } from '../src/strings';
import { installMockServer, jobRowIds, jobRowStatus, renderApp, useMockDb, waitForLive } from './helpers';

/** Spec 002 Part B, screen 1 (Jobs) against the MSW mock API. */

const t = strings.jobs;
const FIXTURE_COUNT = 14;
const NEWEST = fixtureId(14);
const READY_JOB = fixtureId(7); // brochure-a4-3pages
const READY_JOB_2 = fixtureId(8); // menu-board-letter
const HELD_JOB = fixtureId(10);
const DONE_JOB = fixtureId(1);
const MESH_BANNER = fixtureId(11); // priority 80, the highest
/** Keeps ingested jobs in `received` so no events reach the UI during paging tests. */
const PAUSED_PIPELINE = { pipelineDelayMs: 60_000 };
const SLOW_UI_MS = 3_000;

installMockServer();

function row(container: HTMLElement, jobId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`tr[data-job-id="${jobId}"]`);
  if (!element) throw new Error(`No row for ${jobId}`);
  return element;
}

async function renderJobs(path = '/jobs', options = {}) {
  const db = useMockDb(options);
  const view = renderApp(path, db);
  await waitFor(() => expect(jobRowIds(view.container).length).toBeGreaterThan(0));
  return { db, ...view };
}

describe('Jobs list', () => {
  it('shows every column for the fixture jobs, newest first', async () => {
    const { container } = await renderJobs();
    expect(jobRowIds(container)).toHaveLength(FIXTURE_COUNT);
    expect(jobRowIds(container)[0]).toBe(NEWEST);

    const table = screen.getByRole('table', { name: t.caption });
    for (const label of Object.values(t.columns)) {
      expect(within(table).getAllByRole('columnheader', { name: new RegExp(label.replace(/[()]/g, '\\$&')) }).length).toBeGreaterThan(0);
    }

    const brochure = within(row(container, READY_JOB));
    expect(brochure.getByRole('link', { name: 'brochure-a4-3pages' })).toHaveAttribute('href', `/jobs/${READY_JOB}`);
    expect(brochure.getByText(strings.status.ready)).toBeInTheDocument();
    expect(brochure.getByText('Posters')).toBeInTheDocument();
    // First page incl. bleed: A4 + 2 × 8.5 pt.
    expect(brochure.getByText('8.5 × 11.93 in')).toBeInTheDocument();

    const mesh = within(row(container, MESH_BANNER));
    expect(mesh.getByText('Roll printer A')).toBeInTheDocument();
  });

  it('switches the size column between inches and millimetres', async () => {
    const { container, user } = await renderJobs();
    await user.click(screen.getByRole('radio', { name: strings.common.millimetres }));
    expect(within(row(container, READY_JOB)).getByText('216 × 303 mm')).toBeInTheDocument();
    expect(localStorage.getItem('bps.lengthUnit')).toBe('mm');
  });
});

describe('Filters', () => {
  it('filters by status (multi-select) and clears again', async () => {
    const { container, user } = await renderJobs();
    await user.click(screen.getByRole('checkbox', { name: strings.status.failed }));
    await waitFor(() => expect(jobRowIds(container)).toHaveLength(2));
    expect(jobRowIds(container).every((id) => jobRowStatus(container, id) === 'failed')).toBe(true);

    await user.click(screen.getByRole('checkbox', { name: strings.status.cancelled }));
    await waitFor(() => expect(jobRowIds(container)).toHaveLength(3));

    await user.click(screen.getByRole('button', { name: t.clearFilters }));
    await waitFor(() => expect(jobRowIds(container)).toHaveLength(FIXTURE_COUNT));
  });

  it('narrows results with the text search', async () => {
    const { container, user } = await renderJobs();
    await user.type(screen.getByRole('searchbox', { name: t.search }), 'banner');
    await waitFor(() => expect(jobRowIds(container)).toHaveLength(2), { timeout: SLOW_UI_MS });
    const names = jobRowIds(container).map((id) => within(row(container, id)).getByRole('link').textContent);
    expect(names.sort()).toEqual(['banner-3000x1000-sale', 'mesh-banner-fence']);
  });

  it('filters by hot folder and device', async () => {
    const { container, user, db } = await renderJobs();
    await user.selectOptions(screen.getByRole('combobox', { name: t.hotFolderFilter }), 'Banners');
    const banners = db.listJobs(new URLSearchParams({ hotFolderId: HOT_FOLDER_IDS.banners })).items.length;
    await waitFor(() => expect(jobRowIds(container)).toHaveLength(banners));

    await user.selectOptions(screen.getByRole('combobox', { name: t.deviceFilter }), 'Roll printer A');
    await waitFor(() =>
      expect(jobRowIds(container).every((id) => db.getJob(id).deviceId && db.getJob(id).hotFolderId === HOT_FOLDER_IDS.banners)).toBe(true),
    );
    expect(jobRowIds(container).length).toBeLessThan(banners);
  });

  it('reads filters from the URL so views can be shared', async () => {
    const { container } = await renderJobs('/jobs?status=held');
    expect(jobRowIds(container)).toEqual([HELD_JOB]);
    expect(screen.getByRole('checkbox', { name: strings.status.held })).toBeChecked();
  });
});

describe('Sorting and paging', () => {
  it('sorts on column headers and reflects the order in aria-sort', async () => {
    const { container, user } = await renderJobs();
    await user.click(screen.getByRole('button', { name: t.columns.priority }));
    await waitFor(() => expect(jobRowIds(container)[0]).toBe(MESH_BANNER));
    // The table remounts while the new sort loads, so query the header again.
    expect(screen.getByRole('button', { name: t.columns.priority }).closest('th')).toHaveAttribute('aria-sort', 'descending');

    await user.click(screen.getByRole('button', { name: t.columns.name }));
    await waitFor(() => expect(within(row(container, jobRowIds(container)[0])).getByRole('link')).toHaveTextContent('banner-3000x1000-sale'));
    expect(screen.getByRole('button', { name: t.columns.name }).closest('th')).toHaveAttribute('aria-sort', 'ascending');
  });

  it('loads further pages with the cursor', async () => {
    const db = useMockDb(PAUSED_PIPELINE);
    const extra = JOBS_PAGE_SIZE - FIXTURE_COUNT + 4;
    for (let i = 0; i < extra; i += 1) db.ingest({ hotFolderId: HOT_FOLDER_IDS.posters, name: `bulk-${i}` });
    const { container, user } = renderApp('/jobs', db);

    await screen.findByText(t.shown(JOBS_PAGE_SIZE));
    await user.click(screen.getByRole('button', { name: t.loadMore }));
    await screen.findByText(t.shown(FIXTURE_COUNT + extra));
    expect(screen.queryByRole('button', { name: t.loadMore })).not.toBeInTheDocument();
    expect(jobRowIds(container)).toHaveLength(FIXTURE_COUNT + extra);
    expect(container.querySelector('[data-virtualized]')).toHaveAttribute('data-virtualized', 'false');
  });

  it(`virtualizes rows past ${VIRTUALIZE_THRESHOLD} items`, async () => {
    const db = useMockDb(PAUSED_PIPELINE);
    const total = VIRTUALIZE_THRESHOLD + 10;
    for (let i = FIXTURE_COUNT; i < total; i += 1) db.ingest({ hotFolderId: HOT_FOLDER_IDS.posters, name: `bulk-${i}` });
    const { container, user } = renderApp('/jobs', db);

    let loaded = JOBS_PAGE_SIZE;
    await screen.findByText(t.shown(loaded));
    while (loaded < total) {
      await user.click(screen.getByRole('button', { name: t.loadMore }));
      loaded = Math.min(total, loaded + JOBS_PAGE_SIZE);
      await screen.findByText(t.shown(loaded), {}, { timeout: SLOW_UI_MS });
    }
    expect(screen.queryByRole('button', { name: t.loadMore })).not.toBeInTheDocument();
    expect(container.querySelector('[data-virtualized]')).toHaveAttribute('data-virtualized', 'true');
    expect(jobRowIds(container).length).toBeLessThan(total);
  });
});

describe('Live updates (SSE)', () => {
  it('changes a row status without a reload', async () => {
    const { container, db } = await renderJobs();
    await waitForLive();
    db.patchJob(HELD_JOB, { status: 'queued' });
    await waitFor(() => expect(jobRowStatus(container, HELD_JOB)).toBe('queued'));
  });

  it('adds new jobs at the top under created-desc and follows them to ready', async () => {
    const { container, db } = await renderJobs();
    await waitForLive();
    const job = db.ingest({ hotFolderId: HOT_FOLDER_IDS.posters, name: 'live-arrival' });
    if (!job) throw new Error('ingest failed');
    await waitFor(() => expect(jobRowIds(container)[0]).toBe(job.id));
    await waitFor(() => expect(jobRowStatus(container, job.id)).toBe('ready'), { timeout: SLOW_UI_MS });
    expect(jobRowIds(container)).toHaveLength(FIXTURE_COUNT + 1);
  });
});

describe('Bulk actions', () => {
  it('holds, queues and re-prioritizes the selected jobs', async () => {
    const { container, user, db } = await renderJobs();
    const bulk = within(screen.getByRole('region', { name: t.bulk.label }));
    expect(bulk.getByRole('button', { name: t.bulk.hold })).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: t.selectJob('brochure-a4-3pages') }));
    await user.click(screen.getByRole('checkbox', { name: t.selectJob('menu-board-letter') }));
    expect(bulk.getByText(t.bulk.selected(2))).toBeInTheDocument();

    await user.click(bulk.getByRole('button', { name: t.bulk.hold }));
    await screen.findByText(t.bulk.done(2));
    expect([db.getJob(READY_JOB).status, db.getJob(READY_JOB_2).status]).toEqual(['held', 'held']);
    await waitFor(() => expect(jobRowStatus(container, READY_JOB)).toBe('held'));
    expect(bulk.getByText(t.bulk.selected(0))).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: t.selectJob('brochure-a4-3pages') }));
    await user.click(bulk.getByRole('button', { name: t.bulk.queue }));
    await waitFor(() => expect(db.getJob(READY_JOB).status).toBe('queued'));

    await user.click(screen.getByRole('checkbox', { name: t.selectJob('menu-board-letter') }));
    const priority = bulk.getByRole('spinbutton', { name: t.bulk.priority });
    await user.clear(priority);
    await user.type(priority, '90');
    await user.click(bulk.getByRole('button', { name: t.bulk.setPriority }));
    await waitFor(() => expect(db.getJob(READY_JOB_2).priority).toBe(90));
  });

  it('cancels jobs and reports the ones the state machine refuses', async () => {
    const { user, db } = await renderJobs();
    await user.click(screen.getByRole('checkbox', { name: t.selectJob('brochure-a4-3pages') }));
    await user.click(screen.getByRole('checkbox', { name: t.selectJob('rollup-850x2000-spring') }));
    await user.click(screen.getByRole('button', { name: t.bulk.cancel }));
    await screen.findByText(t.bulk.partial(1, 2));
    expect(db.getJob(READY_JOB).status).toBe('cancelled');
    expect(db.getJob(DONE_JOB).status).toBe('done');
  });

  it('selects all loaded jobs from the header checkbox', async () => {
    const { user } = await renderJobs();
    await user.click(screen.getByRole('checkbox', { name: t.selectAll }));
    expect(screen.getByText(t.bulk.selected(FIXTURE_COUNT))).toBeInTheDocument();
  });
});
