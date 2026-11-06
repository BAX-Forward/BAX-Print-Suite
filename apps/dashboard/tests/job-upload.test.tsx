import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { MockDb } from '../mock/db';
import { createMockEventSourceFactory } from '../mock/events';
import { AppProviders, type AppServices } from '../src/App';
import { ApiError } from '../src/api/client';
import { createUploadClient, jobNameFromFileName, type UploadClient } from '../src/api/uploadClient';
import { JobUploadButton, uploadErrorMessage } from '../src/components/JobUploadButton';
import { jobUploadStrings } from '../src/components/jobUploadStrings';
import { formatBytes } from '../src/lib/format';
import { JobsPage } from '../src/pages/JobsUploadPage';
import { strings } from '../src/strings';
import { BASE_URL, createFakeRenderer, createTestApi, createTestQueryClient, installMockServer, jobRowIds, useMockDb } from './helpers';

/**
 * Spec 052b: the opt-in Upload PDF button (BPS_DASHBOARD_JOB_UPLOAD=1). The flag only swaps the
 * job list module at build time, so these tests import the flag-on modules directly.
 */

const t = jobUploadStrings;
const FIXTURE_COUNT = 14;
const PDF_TEXT = '%PDF-1.7\n%%EOF\n';
const PDF_SIZE = new TextEncoder().encode(PDF_TEXT).byteLength;
/** Keeps uploaded jobs in `received` so no pipeline events race the assertions. */
const PAUSED_PIPELINE = { pipelineDelayMs: 60_000 };

installMockServer();

function pdfFile(name: string, content = PDF_TEXT): File {
  return new File([content], name, { type: 'application/pdf' });
}

/** An upload client that sends `contentType` instead of application/pdf (to provoke a 415). */
function clientSending(contentType: string): UploadClient {
  return createUploadClient({
    baseUrl: BASE_URL,
    fetchImpl: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Content-Type', contentType);
      // eslint-disable-next-line no-restricted-globals
      return fetch(input, { ...init, headers, signal: undefined });
    },
  });
}

function renderWithServices(db: MockDb, children: ReactNode) {
  const services: AppServices = {
    api: createTestApi(),
    queryClient: createTestQueryClient(),
    eventSourceFactory: createMockEventSourceFactory(db.events),
    renderer: createFakeRenderer().renderer,
  };
  const user = userEvent.setup();
  const view = render(
    <AppProviders services={services}>
      <MemoryRouter initialEntries={['/jobs']}>{children}</MemoryRouter>
    </AppProviders>,
  );
  return { ...view, user };
}

/** The upload button's own section; the toast provider keeps a separate, always-present alert region. */
function uploadSection() {
  return within(screen.getByRole('region', { name: t.label }));
}

function notifications() {
  return within(screen.getByRole('region', { name: strings.common.notifications }));
}

async function renderUploadPage(db: MockDb) {
  const view = renderWithServices(db, <JobsPage />);
  await waitFor(() => expect(jobRowIds(view.container)).toHaveLength(FIXTURE_COUNT));
  const input = await screen.findByLabelText(t.fileLabel);
  return { ...view, input };
}

describe('Upload PDF button', () => {
  it('uploads the file as a named job and refreshes the list', async () => {
    const db = useMockDb(PAUSED_PIPELINE);
    const { container, user, input } = await renderUploadPage(db);
    expect(screen.getByRole('button', { name: t.button })).toBeEnabled();

    await user.upload(input, pdfFile('uploaded-flyer.pdf'));
    await screen.findByText(t.done('uploaded-flyer'));

    const job = db.listJobs(new URLSearchParams()).items.find((item) => item.name === 'uploaded-flyer');
    if (!job) throw new Error('The upload did not create a job');
    expect(job.sourceFiles[0]?.sizeBytes).toBe(PDF_SIZE);
    expect(job.metadata.displayName).toBe('uploaded-flyer');
    await waitFor(() => expect(jobRowIds(container)).toContain(job.id));
    expect(jobRowIds(container)).toHaveLength(FIXTURE_COUNT + 1);
    expect(uploadSection().queryByRole('alert')).not.toBeInTheDocument();
    expect(notifications().getByRole('alert')).toBeEmptyDOMElement();
  });

  it('reports 413 upload_too_large with the server limit', async () => {
    const limit = PDF_SIZE - 1;
    const { user, input } = await renderUploadPage(useMockDb({ ...PAUSED_PIPELINE, uploadMaxBytes: limit }));
    await user.upload(input, pdfFile('big.pdf'));
    expect(await uploadSection().findByRole('alert')).toHaveTextContent(t.errors.tooLarge(formatBytes(limit)));
  });

  it('reports 400 upload_not_pdf', async () => {
    const { user, input } = await renderUploadPage(useMockDb(PAUSED_PIPELINE));
    await user.upload(input, pdfFile('notes.pdf', 'hello'));
    expect(await uploadSection().findByRole('alert')).toHaveTextContent(t.errors.notPdf);
  });

  it('reports 415 upload_media_type_unsupported', async () => {
    const { user } = renderWithServices(
      useMockDb(PAUSED_PIPELINE),
      <JobUploadButton client={clientSending('application/octet-stream')} />,
    );
    await user.upload(screen.getByLabelText(t.fileLabel), pdfFile('poster.pdf'));
    expect(await uploadSection().findByRole('alert')).toHaveTextContent(t.errors.mediaType);
  });
});

describe('uploadErrorMessage', () => {
  const coded = (status: number, code: string, details?: Record<string, unknown>) =>
    new ApiError(status, null, 'failed', { code, message: 'failed', ...(details ? { details } : {}) });

  it('chooses the message by error code', () => {
    expect(uploadErrorMessage(coded(413, 'upload_too_large', { maxBytes: 2048 }))).toBe(t.errors.tooLarge(formatBytes(2048)));
    expect(uploadErrorMessage(coded(413, 'upload_too_large'))).toBe(t.errors.tooLargeNoLimit);
    expect(uploadErrorMessage(coded(415, 'upload_media_type_unsupported'))).toBe(t.errors.mediaType);
    expect(uploadErrorMessage(coded(400, 'upload_not_pdf'))).toBe(t.errors.notPdf);
  });

  it('falls back on the status for bodies without a code, and on a network message', () => {
    // A proxy's bare 413, and a server without BPS_JOB_INTAKE.
    expect(uploadErrorMessage(new ApiError(413, null, 'failed'))).toBe(t.errors.tooLargeNoLimit);
    expect(uploadErrorMessage(new ApiError(404, null, 'failed'))).toBe(t.errors.unavailable);
    expect(uploadErrorMessage(new TypeError('fetch failed'))).toBe(t.errors.network);
  });
});

describe('jobNameFromFileName', () => {
  it('drops the extension and characters a header cannot carry', () => {
    expect(jobNameFromFileName('Poster A1.PDF')).toBe('Poster A1');
    expect(jobNameFromFileName('plan–b.pdf')).toBe('plan_b');
    expect(jobNameFromFileName('.pdf')).toBeNull();
  });
});
