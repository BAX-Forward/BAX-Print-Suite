import {
  ptToMm,
  tile,
  type SeamTreatment,
  type TileIssue,
  type TilePage,
  type TileSpec,
} from '@bax-print/tile/layout';
import type { JobTiling, JobTilingSeam, JobWithTiling } from '../api/tiling';
import type { Page } from '../api/types';
import { TilePreview } from './TilePreview';
import { tilePreviewStrings } from './tilePreviewStrings';
import ui from './ui.module.css';

/**
 * The job page's tile section (Spec 049c): lays out the job's tiling setting (Spec 050a) with
 * tile() and draws it with TilePreview. Read only. Loaded lazily, and only when the dashboard is
 * built with BPS_DASHBOARD_TILE_PREVIEW=1; imports the pure `@bax-print/tile/layout` entry only, so
 * pdf-lib never reaches the browser bundle.
 */

const t = tilePreviewStrings;

export interface JobTileSectionProps {
  job: Pick<JobWithTiling, 'pages' | 'tiling'>;
}

/** The setting's seam as tile's SeamTreatment; the shapes match field for field (tiling-setting.ts). */
export function seamTreatment(seam: JobTilingSeam): SeamTreatment {
  switch (seam.kind) {
    case 'butt':
      return { kind: 'butt' };
    case 'gap':
      return { kind: 'gap', gapMm: seam.gapMm };
    case 'overlap':
      // Absent overlapMm keeps tile's default overlap.
      return seam.overlapMm === undefined ? { kind: 'overlap' } : { kind: 'overlap', overlapMm: seam.overlapMm };
  }
}

/** A `count` grid with one treatment for every seam; without a seam, tile's default seam applies. */
export function tileSpec(tiling: JobTiling): TileSpec {
  const spec: TileSpec = { grid: { mode: 'count', columns: tiling.grid.columns, rows: tiling.grid.rows } };
  return tiling.seam === undefined ? spec : { ...spec, seam: seamTreatment(tiling.seam) };
}

/** The artwork tile() splits: the page's TrimBox, or the whole page when it has none, in mm. */
export function artworkPage(page: Page): TilePage {
  const box = page.trimBox ?? { width: page.widthPt, height: page.heightPt };
  return { widthMm: ptToMm(box.width), heightMm: ptToMm(box.height) };
}

function TileIssues({ issues }: { issues: readonly TileIssue[] }) {
  return (
    <div className={ui.error} data-tile-issues="">
      <p>{t.issuesHeading}</p>
      <ul>
        {issues.map((issue, i) => (
          <li key={`${issue.code}-${i}`} data-issue={issue.code}>
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function JobTileBody({ job }: JobTileSectionProps) {
  if (job.tiling === undefined) return <p className={ui.muted}>{t.noTiling}</p>;
  const first = job.pages.at(0);
  if (first === undefined) return <p className={ui.muted}>{t.noPages}</p>;
  const page = artworkPage(first);
  const result = tile(page, tileSpec(job.tiling));
  return (
    <>
      {result.issues.length > 0 && <TileIssues issues={result.issues} />}
      {result.panels.length > 0 && <TilePreview page={page} tiling={result} />}
    </>
  );
}

export function JobTileSection({ job }: JobTileSectionProps) {
  return (
    <section aria-labelledby="job-tiling-heading">
      <h2 id="job-tiling-heading">{t.heading}</h2>
      <JobTileBody job={job} />
    </section>
  );
}

/** Default export for React.lazy (JobDetailTilePage). */
export default JobTileSection;
