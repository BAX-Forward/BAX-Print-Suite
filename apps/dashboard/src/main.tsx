import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { createApiClient } from './api/client';
import { AppProviders, AppRoutes, type AppServices } from './App';
import { createQueryClient } from './lib/queryClient';
import { browserEventSourceFactory, type EventSourceFactory } from './live/events';
import { browserBackends } from './preview/browserBackends';
import { createPdfThumbnailRenderer } from './preview/pdfThumbnailRenderer';
import './styles/global.css';

/** The server serves the UI under /ui (vite.config.ts `base`); routes are relative to it. */
const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '');

async function main(): Promise<void> {
  let eventSourceFactory: EventSourceFactory = browserEventSourceFactory;
  // `vite --mode mock` (pnpm --filter dashboard dev:mock): serve the API from MSW in the browser.
  // MODE is replaced at build time, so production bundles drop the mock entirely.
  if (import.meta.env.MODE === 'mock') {
    const { startMockApi } = await import('../mock/browser');
    eventSourceFactory = (await startMockApi()).eventSourceFactory;
  }

  const api = createApiClient();
  const services: AppServices = {
    api,
    queryClient: createQueryClient(),
    eventSourceFactory,
    renderer: createPdfThumbnailRenderer(api, browserBackends),
  };

  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root element');
  createRoot(root).render(
    <StrictMode>
      <AppProviders services={services}>
        <BrowserRouter basename={ROUTER_BASENAME}>
          <AppRoutes />
        </BrowserRouter>
      </AppProviders>
    </StrictMode>,
  );
}

void main();
