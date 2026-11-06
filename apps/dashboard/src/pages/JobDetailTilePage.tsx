import { lazy, Suspense } from 'react';
import { useParams } from 'react-router-dom';
import { useJob } from '../api/queries';
import type { JobWithTiling } from '../api/tiling';
import { tilePreviewStrings } from '../components/tilePreviewStrings';
import ui from '../components/ui.module.css';
import { JobDetailPage as BaseJobDetailPage } from './JobDetailPage';

/**
 * Spec 049c: the job detail route when the dashboard is built with BPS_DASHBOARD_TILE_PREVIEW=1.
 * vite.config.ts (src/lib/tilePreviewPage.ts) swaps it in for App.tsx's JobDetailPage import, so
 * JobDetailPage.tsx itself is unchanged and the flag-off build never sees this module.
 *
 * The tile section and `@bax-print/tile/layout` load lazily, in their own chunk, and only behind
 * `__BPS_TILE_PREVIEW__`, so they are dropped as dead code should this module be built with it off.
 */

const t = tilePreviewStrings;

function lazyTileSection() {
  if (__BPS_TILE_PREVIEW__) return lazy(() => import('../components/JobTileSection'));
  return null;
}

const JobTileSection = lazyTileSection();

function JobTileSlot() {
  const { id = '' } = useParams();
  // Same query key as JobDetailPage, so this reads the cached job rather than fetching it again.
  const job = useJob(id);
  if (JobTileSection === null || job.data === undefined) return null;
  // The 052a Job declares neither `pages` nor `tiling`; widening it lets the section read them when present.
  const tileJob: JobWithTiling = job.data;
  return (
    <Suspense fallback={<p className={ui.muted}>{t.loading}</p>}>
      <JobTileSection job={tileJob} />
    </Suspense>
  );
}

export function JobDetailPage() {
  return (
    <>
      <BaseJobDetailPage />
      {__BPS_TILE_PREVIEW__ && <JobTileSlot />}
    </>
  );
}
