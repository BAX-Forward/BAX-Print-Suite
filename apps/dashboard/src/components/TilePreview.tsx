import { TileSeamHandles, type EditableSeams, type SeamNames } from './TileSeamHandles';
import { tilePreviewStrings } from './tilePreviewStrings';
import ui from './ui.module.css';

/**
 * Drawing of a tile() result (Spec 009 FR10, first slice; Spec 049a): panel rectangles, labels,
 * seam bands and each panel's size in mm. Read only unless `seams` is given (Spec 049d), which adds
 * a draggable, keyboard-operable handle per internal seam; the owner applies the moves.
 *
 * The props mirror the fields of `@bax-print/tile`'s TileResult and Panel that the drawing needs,
 * so a tile() result can be passed as is. Units are millimetres in the artwork frame (origin at
 * the bottom-left, y up); the SVG flips y so row 1 is drawn at the top.
 */

const t = tilePreviewStrings;

export type PreviewSide = 'left' | 'right' | 'bottom' | 'top';
export type PreviewEdgeKind = 'outer' | 'overlap' | 'butt' | 'gap';

export interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewPanel {
  id: string;
  /** 1-based, row 1 is the top row. */
  row: number;
  /** 1-based, column 1 is the leftmost column. */
  col: number;
  label: string;
  /** The row and column parts of `label`; seam handles name panels by them (049d). */
  labelParts?: { row: string; col: string };
  visible: PreviewRect;
  printed: PreviewRect;
  edges: Record<PreviewSide, PreviewEdgeKind>;
  overlapMm: Record<PreviewSide, number>;
}

export interface PreviewTiling {
  panels: readonly PreviewPanel[];
  columns: number;
  rows: number;
  /** Vertical seams, mm from the artwork's left edge. */
  seamsX: readonly number[];
  /** Horizontal seams, mm from the artwork's bottom edge. */
  seamsY: readonly number[];
}

export interface TilePreviewProps {
  page: { widthMm: number; heightMm: number };
  tiling: PreviewTiling;
  /** Which size the dimension text shows. Default `printed` (the tile package's default accounting). */
  measure?: 'printed' | 'visible';
  /**
   * Makes the seams draggable (049d). `positions` place the handles and may differ from
   * `tiling`'s seams while the owner shows an earlier, valid layout; the counts must match.
   */
  seams?: EditableSeams;
}

type SeamKind = 'overlap' | 'gap' | 'butt';

export interface SeamBand {
  key: string;
  axis: 'x' | 'y';
  kind: SeamKind;
  lo: number;
  hi: number;
}

/** Margin around the drawing, as a share of the longer artwork side. */
const PAD_SHARE = 0.02;
/** Text height as a share of the smaller average panel side. */
const FONT_SHARE = 0.1;
const COORD_DIGITS = 3;
const MM_DIGITS = 1;

const COLORS = {
  artwork: '#ffffff',
  outline: '#555555',
  panel: '#1f6feb',
  printed: '#8b949e',
  overlap: '#d29922',
  gap: '#cf222e',
  text: '#1f2328',
};

/** Fixed-precision coordinate, so markup does not depend on float noise. */
function num(value: number): string {
  return String(Number(value.toFixed(COORD_DIGITS)));
}

function formatMm(mm: number): string {
  return String(Number(mm.toFixed(MM_DIGITS)));
}

export function panelDimensions(panel: PreviewPanel, measure: 'printed' | 'visible' = 'printed'): string {
  const rect = measure === 'visible' ? panel.visible : panel.printed;
  return t.dimensions(formatMm(rect.width), formatMm(rect.height));
}

/**
 * The strip each seam occupies, matching the tile package's seamBand(): the overlap printed on
 * either side of the seam, or the unprinted gap centred on it. Butt seams have no width.
 */
function bandFor(axis: 'x' | 'y', index: number, at: number, kind: PreviewEdgeKind, overlapMm: number, visibleEnd: number): SeamBand[] {
  if (kind === 'outer') return [];
  const half = kind === 'overlap' ? overlapMm : kind === 'gap' ? at - visibleEnd : 0;
  return [{ key: `${axis}-${index}`, axis, kind, lo: at - half, hi: at + half }];
}

export function seamBands(tiling: PreviewTiling): SeamBand[] {
  const x = tiling.seamsX.flatMap((at, i) => {
    const before = tiling.panels.find((p) => p.row === 1 && p.col === i + 1);
    if (!before) return [];
    return bandFor('x', i, at, before.edges.right, before.overlapMm.right, before.visible.x + before.visible.width);
  });
  const y = tiling.seamsY.flatMap((at, i) => {
    // Horizontal seams run bottom to top, rows top to bottom: the panel below seam i is in row rows - i.
    const below = tiling.panels.find((p) => p.col === 1 && p.row === tiling.rows - i);
    if (!below) return [];
    return bandFor('y', i, at, below.edges.top, below.overlapMm.top, below.visible.y + below.visible.height);
  });
  return [...x, ...y];
}

/** The panels either side of each seam: columns left and right, rows upper and lower. */
export function seamNames(tiling: PreviewTiling): { x: SeamNames[]; y: SeamNames[] } {
  const colName = (col: number) => {
    const panel = tiling.panels.find((p) => p.row === 1 && p.col === col);
    return panel?.labelParts?.col ?? String(col);
  };
  const rowName = (row: number) => {
    const panel = tiling.panels.find((p) => p.col === 1 && p.row === row);
    return panel?.labelParts?.row ?? String(row);
  };
  return {
    x: tiling.seamsX.map((_, i): SeamNames => [colName(i + 1), colName(i + 2)]),
    // Seam i (bottom to top) lies between rows rows - i - 1 (above) and rows - i (below).
    y: tiling.seamsY.map((_, i): SeamNames => [rowName(tiling.rows - i - 1), rowName(tiling.rows - i)]),
  };
}

export function TilePreview({ page, tiling, measure = 'printed', seams }: TilePreviewProps) {
  if (tiling.panels.length === 0) return <p className={ui.muted}>{t.empty}</p>;

  const { widthMm, heightMm } = page;
  const flipY = (y: number, height: number) => heightMm - y - height;
  const printed = tiling.panels.map((p) => p.printed);
  const minX = Math.min(0, ...printed.map((r) => r.x));
  const maxX = Math.max(widthMm, ...printed.map((r) => r.x + r.width));
  const minY = Math.min(0, ...printed.map((r) => flipY(r.y, r.height)));
  const maxY = Math.max(heightMm, ...printed.map((r) => flipY(r.y, r.height) + r.height));
  const pad = Math.max(widthMm, heightMm) * PAD_SHARE;
  const view = { width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad };
  const viewBox = [minX - pad, minY - pad, view.width, view.height].map(num).join(' ');
  const fontSize = Math.min(widthMm / Math.max(tiling.columns, 1), heightMm / Math.max(tiling.rows, 1)) * FONT_SHARE;
  const stroke = { vectorEffect: 'non-scaling-stroke', strokeWidth: 1 } as const;
  const label = t.label(tiling.columns, tiling.rows);

  const drawing = (
    <>
      <rect
        data-role="artwork"
        x="0"
        y="0"
        width={num(widthMm)}
        height={num(heightMm)}
        fill={COLORS.artwork}
        stroke={COLORS.outline}
        {...stroke}
      />
      {tiling.panels.map((panel) => {
        const { visible: v, printed: p } = panel;
        const dimensions = panelDimensions(panel, measure);
        const cx = v.x + v.width / 2;
        const cy = flipY(v.y, v.height) + v.height / 2;
        return (
          <g key={panel.id} data-panel-id={panel.id}>
            <title>{t.panel(panel.label, dimensions)}</title>
            <rect
              data-role="printed"
              x={num(p.x)}
              y={num(flipY(p.y, p.height))}
              width={num(p.width)}
              height={num(p.height)}
              fill="none"
              stroke={COLORS.printed}
              strokeDasharray="4 3"
              {...stroke}
            />
            <rect
              data-role="visible"
              x={num(v.x)}
              y={num(flipY(v.y, v.height))}
              width={num(v.width)}
              height={num(v.height)}
              fill={COLORS.panel}
              fillOpacity="0.08"
              stroke={COLORS.panel}
              {...stroke}
            />
            <text
              data-role="label"
              x={num(cx)}
              y={num(cy - fontSize * 0.6)}
              fontSize={num(fontSize)}
              fontWeight="bold"
              textAnchor="middle"
              fill={COLORS.text}
            >
              {panel.label}
            </text>
            <text
              data-role="dimensions"
              x={num(cx)}
              y={num(cy + fontSize * 0.8)}
              fontSize={num(fontSize * 0.6)}
              textAnchor="middle"
              fill={COLORS.text}
            >
              {dimensions}
            </text>
          </g>
        );
      })}
      {seamBands(tiling).map((band) => {
        const common = { 'data-seam': band.axis, 'data-kind': band.kind };
        if (band.kind === 'butt' || band.hi <= band.lo) {
          const at = (band.lo + band.hi) / 2;
          return band.axis === 'x' ? (
            <line key={band.key} {...common} x1={num(at)} y1="0" x2={num(at)} y2={num(heightMm)} stroke={COLORS.outline} {...stroke} />
          ) : (
            <line key={band.key} {...common} x1="0" y1={num(flipY(at, 0))} x2={num(widthMm)} y2={num(flipY(at, 0))} stroke={COLORS.outline} {...stroke} />
          );
        }
        const fill = band.kind === 'gap' ? COLORS.gap : COLORS.overlap;
        const size = band.hi - band.lo;
        return band.axis === 'x' ? (
          <rect key={band.key} {...common} x={num(band.lo)} y="0" width={num(size)} height={num(heightMm)} fill={fill} fillOpacity="0.35" />
        ) : (
          <rect key={band.key} {...common} x="0" y={num(flipY(band.lo, size))} width={num(widthMm)} height={num(size)} fill={fill} fillOpacity="0.35" />
        );
      })}
    </>
  );

  if (seams === undefined) {
    return (
      <svg role="img" aria-label={label} viewBox={viewBox} width="100%" data-tile-preview="">
        {drawing}
      </svg>
    );
  }
  // An img role would hide the sliders from assistive technology, so the editor is a group that
  // holds the drawing (still an img) next to the handles.
  return (
    <svg role="group" aria-label={t.editorLabel} viewBox={viewBox} width="100%" data-tile-preview="" data-tile-editor="">
      <g role="img" aria-label={label}>
        {drawing}
      </g>
      <TileSeamHandles
        page={page}
        positions={seams.positions}
        names={seamNames(tiling)}
        view={view}
        onChange={seams.onChange}
      />
    </svg>
  );
}
