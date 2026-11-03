import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { MockDb } from '../mock/db';
import { createMockEventSourceFactory } from '../mock/events';
import { AppProviders, AppRoutes, type AppServices } from '../src/App';
import { createApiClient } from '../src/api/client';
import type { EventSourceFactory, EventSourceLike } from '../src/live/events';
import { strings } from '../src/strings';
import {
  BASE_URL,
  createFakeRenderer,
  createTestQueryClient,
  installMockServer,
  renderApp,
  useMockDb,
  waitForLive,
} from './helpers';

/** Spec 002 Part B, screen 6 (global): navigation, keyboard access, connection indicator, toasts. */

installMockServer();

const PLUGIN_FAILURE = 'The plugin host is not running.';

/** Renders the app with some services replaced. */
function renderWith(path: string, db: MockDb, overrides: Partial<AppServices>) {
  const services: AppServices = {
    api: createApiClient({
      baseUrl: BASE_URL,
      // eslint-disable-next-line no-restricted-globals -- same jsdom AbortSignal workaround as helpers.tsx
      fetchImpl: (input, init) => fetch(input, { ...init, signal: undefined }),
    }),
    queryClient: createTestQueryClient(),
    eventSourceFactory: createMockEventSourceFactory(db.events),
    renderer: createFakeRenderer().renderer,
    ...overrides,
  };
  const user = userEvent.setup();
  const result = render(
    <AppProviders services={services}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );
  return { ...result, user };
}

/** An EventSource whose connection always fails for good (readyState CLOSED). */
function failingFactory(calls: string[]): EventSourceFactory {
  return (url) => {
    calls.push(url);
    const source: EventSourceLike = {
      readyState: 2,
      onopen: null,
      onerror: null,
      addEventListener: () => undefined,
      close: () => undefined,
    };
    setTimeout(() => source.onerror?.(new Event('error')), 0);
    return source;
  };
}

describe('Navigation and keyboard access', () => {
  it('redirects / to the jobs list and marks the current page', async () => {
    renderApp('/', useMockDb());
    expect(await screen.findByRole('heading', { level: 1, name: strings.jobs.title })).toBeInTheDocument();
    const nav = within(screen.getByRole('navigation', { name: strings.nav.label }));
    expect(nav.getByRole('link', { name: strings.nav.jobs })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: strings.nav.devices })).not.toHaveAttribute('aria-current');
  });

  it('has banner and main landmarks and a skip link as the first tab stop', async () => {
    const { user } = renderApp('/hotfolders', useMockDb());
    await screen.findByRole('heading', { level: 1, name: strings.hotFolders.title });
    expect(screen.getByRole('banner')).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');

    await user.tab();
    const skip = screen.getByRole('link', { name: strings.skipToContent });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute('href', '#main');
  });

  it('moves between screens with the keyboard', async () => {
    const { user } = renderApp('/jobs', useMockDb());
    await screen.findByRole('heading', { level: 1, name: strings.jobs.title });
    const nav = within(screen.getByRole('navigation', { name: strings.nav.label }));
    nav.getByRole('link', { name: strings.nav.hotFolders }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: strings.hotFolders.title })).toBeInTheDocument();

    nav.getByRole('link', { name: strings.nav.devices }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: strings.devices.title })).toBeInTheDocument();
  });

  it('shows a not-found page for unknown routes', async () => {
    renderApp('/no-such-screen', useMockDb());
    expect(await screen.findByRole('heading', { level: 1, name: strings.common.notFound })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: strings.common.backToJobs })).toHaveAttribute('href', '/jobs');
  });
});

describe('Connection indicator (SSE state)', () => {
  it('reports the live connection', async () => {
    renderApp('/jobs', useMockDb());
    const indicator = await waitForLive();
    expect(indicator).toHaveTextContent(strings.connection.open);
  });

  it('reports offline when the event stream cannot be opened, and keeps retrying', async () => {
    const db = useMockDb();
    const calls: string[] = [];
    renderWith('/jobs', db, { eventSourceFactory: failingFactory(calls) });
    const indicator = await screen.findByRole('status', { name: strings.connection.label });
    await waitFor(() => expect(indicator).toHaveAttribute('data-state', 'offline'));
    expect(indicator).toHaveTextContent(strings.connection.offline);
    expect(calls[0]).toBe(`${BASE_URL}/events`);
    await waitFor(() => expect(calls.length).toBeGreaterThan(1), { timeout: 3_000 });
  });
});

describe('Toasts', () => {
  it('shows a dismissible toast when a request fails', async () => {
    const db = useMockDb();
    const api = createApiClient({
      baseUrl: BASE_URL,
      fetchImpl: (input, init) => {
        if (String(input).startsWith(`${BASE_URL}/plugins`)) {
          const problem = { type: 'about:blank', title: 'Internal Server Error', status: 500, detail: PLUGIN_FAILURE };
          return Promise.resolve(
            new Response(JSON.stringify(problem), { status: 500, headers: { 'Content-Type': 'application/problem+json' } }),
          );
        }
        // eslint-disable-next-line no-restricted-globals -- same jsdom AbortSignal workaround as helpers.tsx
        return fetch(input, { ...init, signal: undefined });
      },
    });
    const { user } = renderWith('/devices', db, { api });

    const region = within(screen.getByRole('region', { name: strings.common.notifications }));
    const alert = await region.findByRole('alert');
    await waitFor(() => expect(alert).toHaveTextContent(PLUGIN_FAILURE));

    await user.click(region.getByRole('button', { name: strings.common.dismiss }));
    expect(alert).not.toHaveTextContent(PLUGIN_FAILURE);
  });

  it('announces successful actions politely, not as alerts', async () => {
    const { user } = renderApp('/hotfolders', useMockDb());
    const path = await screen.findByRole('textbox', { name: new RegExp(`^${strings.hotFolders.fields.path}`) });
    await user.type(path, '/srv/print/hot/proofs');
    await user.click(screen.getByRole('button', { name: strings.hotFolders.add }));

    const region = within(screen.getByRole('region', { name: strings.common.notifications }));
    await waitFor(() => expect(region.getByRole('status')).toHaveTextContent(strings.hotFolders.added('proofs')));
    expect(region.getByRole('alert')).toBeEmptyDOMElement();
  });
});
