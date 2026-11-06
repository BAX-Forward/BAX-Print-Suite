import { lazy, Suspense } from 'react';
import { JobsPage as BaseJobsPage } from './JobsPage';

/**
 * Spec 052b: the job list route when the dashboard is built with BPS_DASHBOARD_JOB_UPLOAD=1.
 * vite.config.ts (src/lib/jobUploadPage.ts) swaps it in for App.tsx's JobsPage import, so
 * JobsPage.tsx itself is unchanged and the flag-off build never sees this module.
 *
 * The upload button, its strings and the upload client load lazily, in their own chunk.
 */

const JobUploadButton = lazy(() => import('../components/JobUploadButton'));

export function JobsPage() {
  return (
    <>
      <BaseJobsPage />
      <Suspense fallback={null}>
        <JobUploadButton />
      </Suspense>
    </>
  );
}
