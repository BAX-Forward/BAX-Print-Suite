import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { ApiProvider } from './api/ApiContext';
import type { ApiClient } from './api/client';
import { Layout } from './components/Layout';
import { QueryErrorToasts } from './components/QueryErrorToasts';
import { ToastProvider } from './components/Toasts';
import type { EventSourceFactory } from './live/events';
import { LiveProvider } from './live/LiveProvider';
import { DevicesPage } from './pages/DevicesPage';
import { HotFoldersPage } from './pages/HotFoldersPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { JobsPage } from './pages/JobsPage';
import { PreviewProvider } from './preview/PreviewContext';
import type { ThumbnailRenderer } from './preview/types';
import { strings } from './strings';

/** Everything the UI talks to. main.tsx wires the browser versions; tests and mock mode swap them. */
export interface AppServices {
  api: ApiClient;
  queryClient: QueryClient;
  eventSourceFactory: EventSourceFactory;
  renderer: ThumbnailRenderer;
}

export function AppProviders({ services, children }: { services: AppServices; children: ReactNode }) {
  return (
    <ApiProvider client={services.api}>
      <QueryClientProvider client={services.queryClient}>
        <ToastProvider>
          <QueryErrorToasts />
          <LiveProvider url={services.api.eventsUrl()} factory={services.eventSourceFactory}>
            <PreviewProvider renderer={services.renderer}>{children}</PreviewProvider>
          </LiveProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ApiProvider>
  );
}

function NotFoundPage() {
  return (
    <>
      <h1>{strings.common.notFound}</h1>
      <Link to="/jobs">{strings.common.backToJobs}</Link>
    </>
  );
}

/** Routes relative to the router basename (/ui in the browser). */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/jobs" replace />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="jobs/:id" element={<JobDetailPage />} />
        <Route path="hotfolders" element={<HotFoldersPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
