import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { createMockDb, type MockDb, type MockDbOptions } from '../mock/db';
import { createMockEventSourceFactory } from '../mock/events';
import { createHandlers } from '../mock/handlers';
import { AppProviders, AppRoutes, type AppServices } from '../src/App';
import { createApiClient } from '../src/api/client';
import type { ThumbnailRenderer, ThumbnailRequest } from '../src/preview/types';
import { strings } from '../src/strings';

/** Origin the MSW handlers are mounted on in tests. */
export const BASE_URL = 'http://bps.test';

/** Short pipeline delays so simulated steps finish within a test. */
const FAST_DELAYS: MockDbOptions = { pipelineDelayMs: 20, outputDelayMs: 20 };

const server = setupServer();
const dbs: MockDb[] = [];

/** Registers the MSW lifecycle for the calling test file. */
export function installMockServer(): void {
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => {
    server.resetHandlers();
    for (const db of dbs.splice(0)) db.dispose();
  });
  afterAll(() => server.close());
}

/** A fresh in-memory store served by MSW at BASE_URL until the end of the current test. */
export function useMockDb(options: MockDbOptions = {}): MockDb {
  const db = createMockDb({ ...FAST_DELAYS, ...options });
  server.use(...createHandlers(db, BASE_URL));
  dbs.push(db);
  return db;
}

export function createTestApi() {
  return createApiClient({
    baseUrl: BASE_URL,
    // jsdom's AbortSignal is not accepted by Node's fetch, so the signal is dropped here.
    // Request cancellation is not under test; everything else goes through the real client.
    // eslint-disable-next-line no-restricted-globals
    fetchImpl: (input, init) => fetch(input, { ...init, signal: undefined }),
  });
}

/** Renders a solid placeholder image instantly and records every request. */
export function createFakeRenderer() {
  const calls: ThumbnailRequest[] = [];
  const renderer: ThumbnailRenderer = {
    render: async (request) => {
      calls.push(request);
      return { source: {} as CanvasImageSource, width: request.maxPx, height: Math.round(request.maxPx * 0.75) };
    },
  };
  return { renderer, calls };
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

/** Renders the whole app (providers + routes) at `path` against the mock store. */
export function renderApp(path: string, db: MockDb, renderer: ThumbnailRenderer = createFakeRenderer().renderer) {
  const services: AppServices = {
    api: createTestApi(),
    queryClient: createTestQueryClient(),
    eventSourceFactory: createMockEventSourceFactory(db.events),
    renderer,
  };
  const user = userEvent.setup();
  const result = render(
    <AppProviders services={services}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );
  return { ...result, user, services };
}

/** Resolves once the SSE indicator reports an open connection. */
export async function waitForLive(): Promise<HTMLElement> {
  const indicator = await screen.findByRole('status', { name: strings.connection.label });
  await waitFor(() => expect(indicator).toHaveAttribute('data-state', 'open'));
  return indicator;
}

/** Job ids of the table rows, top to bottom. */
export function jobRowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLTableRowElement>('tr[data-job-id]')].map((row) => row.dataset.jobId ?? '');
}

export function jobRowStatus(container: HTMLElement, jobId: string): string | undefined {
  const row = container.querySelector(`tr[data-job-id="${jobId}"]`);
  return row?.querySelector<HTMLElement>('[data-status]')?.dataset.status;
}
