import { setupWorker } from 'msw/browser';
import type { EventSourceFactory } from '../src/live/events';
import { createMockDb, type MockDb } from './db';
import { createMockEventSourceFactory } from './events';
import { HOT_FOLDER_IDS } from './fixtures';
import { createHandlers } from './handlers';

/**
 * Mock mode (`pnpm --filter dashboard dev:mock`): the whole API runs in the browser on MSW.
 * Live updates come from the same in-memory event bus through a mock EventSource.
 */

/** A sample file "arrives" in a hot folder this often, so live updates are visible. */
const INGEST_INTERVAL_MS = 45_000;

export interface MockApi {
  db: MockDb;
  eventSourceFactory: EventSourceFactory;
}

declare global {
  interface Window {
    /** Mock store, exposed in mock mode for manual testing and the Playwright smoke test. */
    __bpsMock?: MockDb;
  }
}

export async function startMockApi(): Promise<MockApi> {
  const db = createMockDb();
  const worker = setupWorker(...createHandlers(db, location.origin));
  await worker.start({
    // public/ is served under the app base (/ui/), which also becomes the worker scope.
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    onUnhandledRequest: 'bypass',
    quiet: true,
  });

  let sample = 0;
  setInterval(() => {
    sample += 1;
    db.ingest({ hotFolderId: HOT_FOLDER_IDS.posters, name: `incoming-sample-${sample}` });
  }, INGEST_INTERVAL_MS);

  window.__bpsMock = db;
  return { db, eventSourceFactory: createMockEventSourceFactory(db.events) };
}
