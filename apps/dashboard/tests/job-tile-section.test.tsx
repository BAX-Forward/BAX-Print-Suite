import { mmToPt, tile } from '@bax-print/tile/layout';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { JobTiling } from '../src/api/tiling';
import type { Page } from '../src/api/types';
import { artworkPage, JobTileSection, seamTreatment, tileSpec } from '../src/components/JobTileSection';
import { tilePreviewStrings } from '../src/components/tilePreviewStrings';

/**
 * Spec 049c: the job page's tile section. __BPS_TILE_PREVIEW__ is false in vitest, so these tests
 * render JobTileSection directly, as the flag-on JobDetailTilePage does.
 */

const t = tilePreviewStrings;

/** A 3000 × 2000 mm page without a TrimBox. */
const PAGE: Page = { index: 0, widthPt: mmToPt(3000), heightPt: mmToPt(2000), trimBox: null };
const OVERLAP_3X2: JobTiling = { grid: { columns: 3, rows: 2 }, seam: { kind: 'overlap', overlapMm: 20 } };

function renderSection(tiling: JobTiling | undefined, pages: Page[] = [PAGE]) {
  const view = render(<JobTileSection job={tiling === undefined ? { pages } : { pages, tiling }} />);
  const section = screen.getByRole('region', { name: t.heading });
  return { ...view, section };
}

describe('JobTileSection', () => {
  it('draws the panels of a 3 × 2 overlap tiling', () => {
    const { section } = renderSection(OVERLAP_3X2);
    const svg = within(section).getByRole('img', { name: t.label(3, 2) });
    const ids = [...svg.querySelectorAll('g[data-panel-id]')].map((g) => g.getAttribute('data-panel-id'));
    expect(ids).toEqual(['1-1', '1-2', '1-3', '2-1', '2-2', '2-3']);
    const labels = [...svg.querySelectorAll('text[data-role="label"]')].map((node) => node.textContent);
    expect(labels).toEqual(['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);

    const seams = [...svg.querySelectorAll('[data-seam]')];
    expect(seams.map((s) => [s.getAttribute('data-seam'), s.getAttribute('data-kind')])).toEqual([
      ['x', 'overlap'],
      ['x', 'overlap'],
      ['y', 'overlap'],
    ]);
    // 20 mm printed either side of the seam at 1000 mm.
    expect([seams[0]?.getAttribute('x'), seams[0]?.getAttribute('width')]).toEqual(['980', '40']);
    expect(section.querySelector('[data-tile-issues]')).toBeNull();
  });

  it('lays out the TrimBox when the page has one', () => {
    const trimmed: Page = { ...PAGE, trimBox: { x: 9, y: 9, width: mmToPt(1500), height: mmToPt(1000) } };
    const artwork = artworkPage(trimmed);
    expect(artwork.widthMm).toBeCloseTo(1500, 9);
    expect(artwork.heightMm).toBeCloseTo(1000, 9);
    const { section } = renderSection({ grid: { columns: 2, rows: 1 } }, [trimmed]);
    expect(within(section).getByRole('img', { name: t.label(2, 1) })).toBeInTheDocument();
  });

  it('shows an empty state when the job has no tiling', () => {
    const { section, container } = renderSection(undefined);
    expect(section).toHaveTextContent(t.noTiling);
    expect(container.querySelector('svg, [data-tile-issues]')).toBeNull();
  });

  it('says so when the job has no pages', () => {
    const { section, container } = renderSection(OVERLAP_3X2, []);
    expect(section).toHaveTextContent(t.noPages);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('lists tile() issues as text for a spec tile rejects', () => {
    // An overlap wider than the 1000 mm panels.
    const invalid: JobTiling = { grid: { columns: 3, rows: 2 }, seam: { kind: 'overlap', overlapMm: 1200 } };
    const expected = tile(artworkPage(PAGE), tileSpec(invalid)).issues;
    expect(expected.map((issue) => issue.code)).toContain('overlap-exceeds-panel');

    const { section } = renderSection(invalid);
    expect(section).toHaveTextContent(t.issuesHeading);
    const items = within(section).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(expected.map((issue) => issue.message));
    expect(items.map((item) => item.getAttribute('data-issue'))).toEqual(expected.map((issue) => issue.code));
  });

  it('lists issues for a grid tile rejects outright, without a drawing', () => {
    const { section, container } = renderSection({ grid: { columns: 0, rows: 2 } });
    expect(within(section).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-issue="invalid-grid"]')).not.toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('tiling setting to tile spec', () => {
  it('uses a count grid and keeps tile’s default seam when the setting has none', () => {
    expect(tileSpec({ grid: { columns: 4, rows: 3 } })).toEqual({ grid: { mode: 'count', columns: 4, rows: 3 } });
  });

  it('maps each seam kind field for field', () => {
    expect(seamTreatment({ kind: 'butt' })).toEqual({ kind: 'butt' });
    expect(seamTreatment({ kind: 'gap', gapMm: 8 })).toEqual({ kind: 'gap', gapMm: 8 });
    expect(seamTreatment({ kind: 'overlap', overlapMm: 0 })).toEqual({ kind: 'overlap', overlapMm: 0 });
    expect(seamTreatment({ kind: 'overlap' })).toEqual({ kind: 'overlap' });
    expect(tileSpec(OVERLAP_3X2)).toEqual({
      grid: { mode: 'count', columns: 3, rows: 2 },
      seam: { kind: 'overlap', overlapMm: 20 },
    });
  });
});
