import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockDb, type MockDb } from '../mock/db';
import { createMockEventSourceFactory } from '../mock/events';
import { AppProviders, AppRoutes, type AppServices } from '../src/App';
import { createApiClient } from '../src/api/client';
import { createUploadClient } from '../src/api/uploadClient';
import { JobUploadButton, uploadErrorMessage } from '../src/components/JobUploadButton';
import { jobUploadStrings } from '../src/components/jobUploadStrings';
import { formatBytes } from '../src/lib/format';
import { strings } from '../src/strings';
import responses from './fixtures/server-052a-responses.json';
import { createFakeRenderer, createTestQueryClient } from './helpers';

/**
 * Spec 052b-rework: the real client functions and screens against the bodies the 052a server
 * answered (tests/fixtures/server-052a-responses.json, captured via app.inject). No MSW here: fetch
 * is stubbed with the captured responses, so a shape the mock invents cannot hide a mismatch.
 */

const BASE_URL = 'http://bps-052a.test';
const PDF_TEXT = '%PDF-1.7\n%%EOF\n';
const PDF_BYTES = new TextEncoder().encode(PDF_TEXT);
const KNOWN_JOB = responses.getJob.body.job;
const MISSING_JOB = 'job-9999';
const LAST_PAGE_CURSOR = responses.listPage1.body.nextCursor;

interface Captured {
  status: number;
  body: unknown;
}

function reply({ status, body }: Captured): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const requested: URL[] = [];

/** Answers GET /jobs, GET /jobs/:id with the captured bodies; anything else gets the captured 404 envelope. */
const fixtureFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  requested.push(url);
  const method = init?.method ?? 'GET';
  if (method === 'GET' && url.pathname === '/jobs') {
    return reply(url.searchParams.get('cursor') === LAST_PAGE_CURSOR ? responses.listPage2 : responses.listPage1);
  }
  if (method === 'GET' && url.pathname === `/jobs/${KNOWN_JOB.id}`) return reply(responses.getJob);
  return reply(responses.getJobNotFound);
};

const dbs: MockDb[] = [];
afterEach(() => {
  requested.length = 0;
  for (const db of dbs.splice(0)) db.dispose();
});

function renderWithFixtures(path: string, children: ReactNode = <AppRoutes />) {
  // Only its event bus is used: the screens get no live events.
  const db = createMockDb({ seed: false });
  dbs.push(db);
  const services: AppServices = {
    api: createApiClient({ baseUrl: BASE_URL, fetchImpl: fixtureFetch }),
    queryClient: createTestQueryClient(),
    eventSourceFactory: createMockEventSourceFactory(db.events),
    renderer: createFakeRenderer().renderer,
  };
  const user = userEvent.setup();
  const view = render(
    <AppProviders services={services}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </AppProviders>,
  );
  return { ...view, user };
}

describe('API client against the captured 052a responses', () => {
  const api = createApiClient({ baseUrl: BASE_URL, fetchImpl: fixtureFetch });

  it('reads {items, nextCursor} and stops on a null cursor', async () => {
    const first = await api.listJobs({ limit: 2 });
    expect(first.items.map((job) => job.name)).toEqual(['Card C', 'Banner B']);
    expect(first.nextCursor).toBe(LAST_PAGE_CURSOR);

    const last = await api.listJobs({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(last.items.map((job) => job.name)).toEqual(['Poster A']);
    expect(last.nextCursor).toBeNull();
  });

  it('sends limit and cursor only', async () => {
    await api.listJobs({ limit: 2, cursor: LAST_PAGE_CURSOR });
    expect(requested.map((url) => [...url.searchParams.keys()].sort())).toEqual([['cursor', 'limit']]);
  });

  it('unwraps {job} and reports the 404 envelope', async () => {
    expect(await api.getJob(KNOWN_JOB.id)).toEqual(KNOWN_JOB);
    await expect(api.getJob(MISSING_JOB)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
      message: responses.getJobNotFound.body.error.message,
    });
  });
});

describe('Screens against the captured 052a responses', () => {
  it('lists the jobs page by page until nextCursor is null', async () => {
    const { user } = renderWithFixtures('/jobs');
    expect(await screen.findByRole('link', { name: 'Card C' })).toHaveAttribute('href', '/jobs/job-0003');
    expect(screen.getByRole('link', { name: 'Banner B' })).toHaveAttribute('href', '/jobs/job-0002');
    expect(screen.getByText(strings.jobs.shown(2))).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: strings.jobs.loadMore }));
    expect(await screen.findByRole('link', { name: 'Poster A' })).toHaveAttribute('href', `/jobs/${KNOWN_JOB.id}`);
    expect(screen.getByText(strings.jobs.shown(3))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: strings.jobs.loadMore })).not.toBeInTheDocument();
  });

  it('shows the job detail', async () => {
    renderWithFixtures(`/jobs/${KNOWN_JOB.id}`);
    expect(await screen.findByRole('heading', { level: 1, name: KNOWN_JOB.name })).toBeInTheDocument();
    const details = within(screen.getByRole('region', { name: strings.jobDetail.detailsHeading }));
    const source = KNOWN_JOB.sourceFiles[0];
    if (!source) throw new Error('The captured job has no source file');
    expect(details.getByText(KNOWN_JOB.id)).toBeInTheDocument();
    expect(details.getByText(strings.status.received)).toBeInTheDocument();
    expect(details.getByText(source.name)).toBeInTheDocument();
    expect(details.getByText(source.sha256)).toBeInTheDocument();
    expect(details.getByText(formatBytes(source.sizeBytes))).toBeInTheDocument();
  });

  it('shows the not-found view for the 404 envelope', async () => {
    renderWithFixtures(`/jobs/${MISSING_JOB}`);
    expect(await screen.findByRole('heading', { level: 1, name: strings.jobDetail.notFound })).toBeInTheDocument();
  });
});

describe('Upload against the captured 052a responses', () => {
  const t = jobUploadStrings;
  const uploadClient = (captured: Captured) =>
    createUploadClient({ baseUrl: BASE_URL, fetchImpl: async () => reply(captured) });

  it('returns the created job from {job}', async () => {
    expect(await uploadClient(responses.createJob).uploadJob(PDF_BYTES, 'Poster A')).toEqual(responses.createJob.body.job);
  });

  const cases: [label: string, captured: Captured, message: string][] = [
    ['413 upload_too_large', responses.uploadTooLarge, t.errors.tooLarge(formatBytes(responses.uploadTooLarge.body.error.details.maxBytes))],
    ['415 upload_media_type_unsupported', responses.uploadWrongType, t.errors.mediaType],
    ['400 upload_not_pdf', responses.uploadNotPdf, t.errors.notPdf],
  ];

  it.each(cases)('maps %s to its message', async (_label, captured, message) => {
    const error = await uploadClient(captured)
      .uploadJob(PDF_BYTES, 'Poster A')
      .then(
        () => new Error('The upload was expected to fail'),
        (reason: unknown) => reason,
      );
    expect(uploadErrorMessage(error)).toBe(message);
  });

  it.each(cases)('shows %s on the upload button', async (_label, captured, message) => {
    const { user } = renderWithFixtures('/jobs', <JobUploadButton client={uploadClient(captured)} />);
    await user.upload(screen.getByLabelText(t.fileLabel), new File([PDF_TEXT], 'poster.pdf', { type: 'application/pdf' }));
    const section = within(screen.getByRole('region', { name: t.label }));
    expect(await section.findByRole('alert')).toHaveTextContent(message);
  });
});
