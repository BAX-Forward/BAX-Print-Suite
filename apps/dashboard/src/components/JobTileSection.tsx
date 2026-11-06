import { useState } from 'react';
import {
  ptToMm,
  tile,
  type Panel,
  type SeamTreatment,
  type TileIssue,
  type TilePage,
  type TileResult,
  type TileSpec,
} from '@bax-print/tile/layout';
import type { JobTiling, JobTilingSeam, JobWithTiling } from '../api/tiling';
import type { Page } from '../api/types';
import { panelDimensions, TilePreview } from './TilePreview';
import type { SeamChange, SeamPositions } from './TileSeamHandles';
import { tilePreviewStrings } from './tilePreviewStrings';
import ui from './ui.module.css';

/**
 * The job page's tile section (Spec 049c): lays out the job's tiling setting (Spec 050a) with
 * tile() and draws it with TilePreview. Loaded lazily, and only when the dashboard is built with
 * BPS_DASHBOARD_TILE_PREVIEW=1; imports the pure `@bax-print/tile/layout` entry only, so pdf-lib
 * never reaches the browser bundle.
 *
 * Spec 049d: the seams can be dragged or nudged. Each move re-runs tile() with explicit seam
 * positions and shows the result; an invalid move lists tile's issues while the last valid layout
 * stays drawn. The edit is local state only: nothing is sent to the server, and Reset restores
 * the job's tiling.
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

/** The job's spec with explicit seams on both axes (049d); tile's seamsX and seamsY override the grid. */
export function editedSpec(tiling: JobTiling, positions: SeamPositions): TileSpec {
  return { ...tileSpec(tiling), seamsX: [...positions.x], seamsY: [...positions.y] };
}

/** `positions` with one seam moved to `mm`. */
export function movedSeams(positions: SeamPositions, axis: 'x' | 'y', index: number, mm: number): SeamPositions {
  const update = (list: readonly number[]) => list.map((at, i) => (i === index ? mm : at));
  return axis === 'x' ? { x: update(positions.x), y: positions.y } : { x: positions.x, y: update(positions.y) };
}

function PanelSizes({ panels }: { panels: readonly Panel[] }) {
  return (
    <div data-panel-sizes="">
      <p>{t.sizesHeading}</p>
      <ul aria-label={t.sizesHeading}>
        {panels.map((panel) => (
          <li key={panel.id} data-panel-size={panel.id}>
            {t.panelSize(panel.label, panelDimensions(panel))}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface SeamEdit {
  positions: SeamPositions;
  /** tile() for `positions`, possibly with issues. */
  result: TileResult;
  /** The latest result without issues; drawn while `result` has some. */
  lastValid: TileResult;
}

interface JobTileEditorProps {
  page: TilePage;
  tiling: JobTiling;
  /** tile() for the job's own tiling; has panels. */
  base: TileResult;
}

function JobTileEditor({ page, tiling, base }: JobTileEditorProps) {
  // null until the first move, and again after Reset: the job's own tiling applies.
  const [edit, setEdit] = useState<SeamEdit | null>(null);
  const initial: SeamPositions = { x: base.seamsX, y: base.seamsY };
  const positions = edit?.positions ?? initial;
  const shown = edit?.result ?? base;
  const drawn = edit?.lastValid ?? base;

  const onChange: SeamChange = (axis, index, mm) => {
    setEdit((current) => {
      const next = movedSeams(current?.positions ?? initial, axis, index, mm);
      const result = tile(page, editedSpec(tiling, next));
      return { positions: next, result, lastValid: result.ok ? result : (current?.lastValid ?? base) };
    });
  };

  return (
    <>
      <p className={ui.hint} data-tile-edit-status="">
        <strong>{t.notSaved}</strong> {t.editHint}
      </p>
      <div aria-live="polite">
        {shown.issues.length > 0 && <TileIssues issues={shown.issues} />}
        {shown !== drawn && <p className={ui.muted}>{t.lastValid}</p>}
      </div>
      <TilePreview page={page} tiling={drawn} seams={{ positions, onChange }} />
      <PanelSizes panels={drawn.panels} />
      <button type="button" onClick={() => setEdit(null)} disabled={edit === null}>
        {t.reset}
      </button>
    </>
  );
}

function JobTileBody({ job }: JobTileSectionProps) {
  if (job.tiling === undefined) return <p className={ui.muted}>{t.noTiling}</p>;
  const first = job.pages?.at(0);
  if (first === undefined) return <p className={ui.muted}>{t.noPages}</p>;
  const page = artworkPage(first);
  const result = tile(page, tileSpec(job.tiling));
  if (result.panels.length === 0) return <TileIssues issues={result.issues} />;
  // A changed tiling or page (not a refetch of the same job) starts a fresh, unedited editor.
  const key = JSON.stringify({ page, tiling: job.tiling });
  return <JobTileEditor key={key} page={page} tiling={job.tiling} base={result} />;
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
