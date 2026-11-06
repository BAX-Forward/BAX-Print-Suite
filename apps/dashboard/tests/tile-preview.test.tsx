import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  panelDimensions,
  seamBands,
  TilePreview,
  type PreviewEdgeKind,
  type PreviewPanel,
  type PreviewTiling,
} from '../src/components/TilePreview';
import { tilePreviewStrings } from '../src/components/tilePreviewStrings';

/** Spec 049a: read-only tile preview (Spec 009 FR10, first slice). */

const t = tilePreviewStrings;
const PAGE = { widthMm: 3000, heightMm: 2000 };

interface Span {
  visLo: number;
  visHi: number;
  lo: PreviewEdgeKind;
  hi: PreviewEdgeKind;
  loOverlap: number;
  hiOverlap: number;
}

/**
 * A fixed 3 columns × 2 rows grid, written out by hand with the tile package's span rules:
 * x seams at 1000 mm (25 mm overlap) and 2000 mm (10 mm gap), y seam at 1000 mm (butt).
 */
const X_SPANS: Span[] = [
  { visLo: 0, visHi: 1000, lo: 'outer', hi: 'overlap', loOverlap: 0, hiOverlap: 25 },
  { visLo: 1000, visHi: 1995, lo: 'overlap', hi: 'gap', loOverlap: 25, hiOverlap: 0 },
  { visLo: 2005, visHi: 3000, lo: 'gap', hi: 'outer', loOverlap: 0, hiOverlap: 0 },
];
/** Bottom to top, like the artwork frame. */
const Y_SPANS: Span[] = [
  { visLo: 0, visHi: 1000, lo: 'outer', hi: 'butt', loOverlap: 0, hiOverlap: 0 },
  { visLo: 1000, visHi: 2000, lo: 'butt', hi: 'outer', loOverlap: 0, hiOverlap: 0 },
];
const LABELS = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'];

function makePanel(row: number, col: number, x: Span, y: Span): PreviewPanel {
  const prLoX = x.visLo - x.loOverlap;
  const prLoY = y.visLo - y.loOverlap;
  return {
    id: `${row}-${col}`,
    row,
    col,
    label: `${'AB'.charAt(row - 1)}${col}`,
    visible: { x: x.visLo, y: y.visLo, width: x.visHi - x.visLo, height: y.visHi - y.visLo },
    printed: {
      x: prLoX,
      y: prLoY,
      width: x.visHi + x.hiOverlap - prLoX,
      height: y.visHi + y.hiOverlap - prLoY,
    },
    edges: { left: x.lo, right: x.hi, bottom: y.lo, top: y.hi },
    overlapMm: { left: x.loOverlap, right: x.hiOverlap, bottom: y.loOverlap, top: y.hiOverlap },
  };
}

function grid(): PreviewTiling {
  const panels = [...Y_SPANS]
    .reverse()
    .flatMap((y, r) => X_SPANS.map((x, c) => makePanel(r + 1, c + 1, x, y)));
  return { panels, columns: 3, rows: 2, seamsX: [1000, 2000], seamsY: [1000] };
}

function renderPreview(tiling: PreviewTiling = grid(), measure?: 'printed' | 'visible') {
  const view = render(<TilePreview page={PAGE} tiling={tiling} measure={measure} />);
  const svg = view.container.querySelector('svg');
  if (!svg) throw new Error('TilePreview rendered no <svg>');
  return { ...view, svg };
}

const texts = (svg: SVGSVGElement, role: string) =>
  [...svg.querySelectorAll(`text[data-role="${role}"]`)].map((node) => node.textContent);

describe('TilePreview', () => {
  it('draws one labelled group per panel, row-major from the top-left', () => {
    const { svg } = renderPreview();
    expect(svg).toHaveAttribute('role', 'img');
    expect(svg).toHaveAttribute('aria-label', t.label(3, 2));
    const groups = [...svg.querySelectorAll('g[data-panel-id]')];
    expect(groups.map((g) => g.getAttribute('data-panel-id'))).toEqual(['1-1', '1-2', '1-3', '2-1', '2-2', '2-3']);
    expect(svg.querySelectorAll('rect[data-role="visible"]')).toHaveLength(6);
    expect(svg.querySelectorAll('rect[data-role="printed"]')).toHaveLength(6);
    expect(texts(svg, 'label')).toEqual(LABELS);
  });

  it('shows each panel’s printed width × height in mm', () => {
    const { svg } = renderPreview();
    const row = ['1025 × 1000 mm', '1020 × 1000 mm', '995 × 1000 mm'];
    expect(texts(svg, 'dimensions')).toEqual([...row, ...row]);
    const titles = [...svg.querySelectorAll('g[data-panel-id] > title')].map((node) => node.textContent);
    expect(titles[0]).toBe(t.panel('A1', '1025 × 1000 mm'));
    expect(titles).toHaveLength(6);
  });

  it('can show the visible size instead', () => {
    const { svg } = renderPreview(grid(), 'visible');
    const row = ['1000 × 1000 mm', '995 × 1000 mm', '995 × 1000 mm'];
    expect(texts(svg, 'dimensions')).toEqual([...row, ...row]);
  });

  it('draws overlap and gap seams as bands and butt seams as a line', () => {
    const { svg } = renderPreview();
    const seams = [...svg.querySelectorAll('[data-seam]')];
    expect(seams.map((s) => [s.tagName, s.getAttribute('data-seam'), s.getAttribute('data-kind')])).toEqual([
      ['rect', 'x', 'overlap'],
      ['rect', 'x', 'gap'],
      ['line', 'y', 'butt'],
    ]);
    const [overlap, gap, butt] = seams;
    // 25 mm either side of the seam at 1000 mm; the 10 mm gap centred on 2000 mm.
    expect([overlap?.getAttribute('x'), overlap?.getAttribute('width')]).toEqual(['975', '50']);
    expect([gap?.getAttribute('x'), gap?.getAttribute('width')]).toEqual(['1995', '10']);
    // y is flipped: the seam 1000 mm above the bottom of a 2000 mm artwork is at SVG y 1000.
    expect([butt?.getAttribute('y1'), butt?.getAttribute('y2'), butt?.getAttribute('x2')]).toEqual(['1000', '1000', '3000']);
  });

  it('places row 1 at the top of the drawing', () => {
    const { svg } = renderPreview();
    const top = svg.querySelector('g[data-panel-id="1-1"] rect[data-role="visible"]');
    const bottom = svg.querySelector('g[data-panel-id="2-1"] rect[data-role="visible"]');
    expect(top?.getAttribute('y')).toBe('0');
    expect(bottom?.getAttribute('y')).toBe('1000');
  });

  it('pads the view box around printed areas outside the artwork', () => {
    const tiling = grid();
    const bled: PreviewTiling = {
      ...tiling,
      panels: tiling.panels.map((p) => ({ ...p, printed: { ...p.printed, x: p.printed.x - 5, width: p.printed.width + 10 } })),
    };
    const { svg } = renderPreview(bled);
    // 2% of 3000 mm padding beyond the 5 mm bleed on the left.
    expect(svg.getAttribute('viewBox')?.split(' ')[0]).toBe('-65');
  });

  it('renders deterministic markup', () => {
    const first = renderPreview().container.innerHTML;
    const second = renderPreview(grid()).container.innerHTML;
    expect(second).toBe(first);
    expect(first).not.toMatch(/\d\.\d{4,}/); // coordinates are rounded
  });

  it('says so when there are no panels (invalid grid)', () => {
    const { container } = render(
      <TilePreview page={PAGE} tiling={{ panels: [], columns: 0, rows: 0, seamsX: [], seamsY: [] }} />,
    );
    expect(container.querySelector('svg')).toBeNull();
    expect(container).toHaveTextContent(t.empty);
  });
});

describe('seamBands and panelDimensions', () => {
  it('derive seam strips and sizes from the panels', () => {
    expect(seamBands(grid())).toEqual([
      { key: 'x-0', axis: 'x', kind: 'overlap', lo: 975, hi: 1025 },
      { key: 'x-1', axis: 'x', kind: 'gap', lo: 1995, hi: 2005 },
      { key: 'y-0', axis: 'y', kind: 'butt', lo: 1000, hi: 1000 },
    ]);
    const panel = grid().panels[1];
    expect(panel && panelDimensions(panel)).toBe('1020 × 1000 mm');
  });
});
