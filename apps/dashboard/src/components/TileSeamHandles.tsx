import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { tilePreviewStrings } from './tilePreviewStrings';
import styles from './tileSeams.module.css';

/**
 * Draggable seam handles for TilePreview (Spec 049d). Each internal seam is a focusable
 * role="slider" whose value is the seam position in mm. A pointer drag (with pointer capture) or
 * the keyboard moves it; the new position goes to `onChange` and nothing else happens here: the
 * owner re-runs tile() and passes the result back in. Units and frame as in TilePreview.
 */

const t = tilePreviewStrings;

export type SeamAxis = 'x' | 'y';
export type SeamChange = (axis: SeamAxis, index: number, mm: number) => void;

export interface SeamPositions {
  /** Vertical seams, mm from the artwork's left edge, left to right. */
  x: readonly number[];
  /** Horizontal seams, mm from the artwork's bottom edge, bottom to top. */
  y: readonly number[];
}

export interface EditableSeams {
  positions: SeamPositions;
  onChange: SeamChange;
}

/** The two panel names either side of a seam: left and right, or upper and lower. */
export type SeamNames = readonly [string, string];

export interface TileSeamHandlesProps extends EditableSeams {
  page: { widthMm: number; heightMm: number };
  /** Names per seam, indexed like `positions`. */
  names: { x: readonly SeamNames[]; y: readonly SeamNames[] };
  /** The SVG view box size in mm, to turn pointer movement in pixels into mm. */
  view: { width: number; height: number };
}

export const STEP_MM = 1;
export const LARGE_STEP_MM = 10;
/** Width of a handle's hit area as a share of the longer artwork side. */
const HIT_SHARE = 0.01;
/** Dragged positions snap to 0.1 mm. */
const DRAG_DIGITS = 1;
const MM_DIGITS = 1;
const HANDLE_FILL = '#1f6feb';

function roundTo(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A seam may move between its neighbours, or the artwork edges for the outermost seams. */
export function seamBounds(positions: readonly number[], index: number, length: number): { min: number; max: number } {
  return { min: positions[index - 1] ?? 0, max: positions[index + 1] ?? length };
}

/**
 * The position a key moves a seam to, or undefined for keys the slider ignores. Arrow keys step
 * 1 mm (10 mm with Shift), Left and Down towards the origin; Home and End jump to the bounds.
 */
export function keyedPosition(key: string, shift: boolean, value: number, min: number, max: number): number | undefined {
  const step = shift ? LARGE_STEP_MM : STEP_MM;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(value - step, min, max);
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(value + step, min, max);
    case 'Home':
      return min;
    case 'End':
      return max;
    default:
      return undefined;
  }
}

interface Drag {
  pointerId: number;
  /** Pointer coordinate along the seam's axis at pointerdown, in CSS pixels. */
  startPx: number;
  startMm: number;
  mmPerPx: number;
}

interface SeamHandleProps {
  axis: SeamAxis;
  index: number;
  value: number;
  min: number;
  max: number;
  label: string;
  page: TileSeamHandlesProps['page'];
  view: TileSeamHandlesProps['view'];
  onChange: SeamChange;
}

function SeamHandle({ axis, index, value, min, max, label, page, view, onChange }: SeamHandleProps) {
  const drag = useRef<Drag | null>(null);
  const move = (mm: number) => {
    if (mm !== value) onChange(axis, index, mm);
  };
  const along = (event: PointerEvent) => (axis === 'x' ? event.clientX : event.clientY);

  const onPointerDown = (event: PointerEvent<SVGRectElement>) => {
    if (event.button !== 0) return;
    const svg = event.currentTarget.ownerSVGElement;
    if (svg === null) return;
    const box = svg.getBoundingClientRect();
    // The drawing keeps its aspect ratio (width 100%, height auto), so one scale serves both axes.
    const mmPerPx = Math.max(view.width / box.width, view.height / box.height);
    if (Number.isFinite(mmPerPx) === false || mmPerPx <= 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    drag.current = { pointerId: event.pointerId, startPx: along(event), startMm: value, mmPerPx };
  };
  const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    const px = along(event) - current.startPx;
    // SVG y runs down, the artwork frame's y up.
    const deltaMm = (axis === 'x' ? px : -px) * current.mmPerPx;
    move(clamp(roundTo(current.startMm + deltaMm, DRAG_DIGITS), min, max));
  };
  const endDrag = (event: PointerEvent<SVGRectElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<SVGRectElement>) => {
    const next = keyedPosition(event.key, event.shiftKey, value, min, max);
    if (next === undefined) return;
    event.preventDefault();
    move(next);
  };

  const hit = Math.max(page.widthMm, page.heightMm) * HIT_SHARE;
  const rect =
    axis === 'x'
      ? { x: value - hit / 2, y: 0, width: hit, height: page.heightMm }
      : { x: 0, y: page.heightMm - value - hit / 2, width: page.widthMm, height: hit };
  const shown = roundTo(value, MM_DIGITS);

  return (
    <rect
      className={styles.handle}
      data-seam-handle={axis}
      data-axis={axis}
      x={roundTo(rect.x, 3)}
      y={roundTo(rect.y, 3)}
      width={roundTo(rect.width, 3)}
      height={roundTo(rect.height, 3)}
      fill={HANDLE_FILL}
      fillOpacity="0"
      vectorEffect="non-scaling-stroke"
      tabIndex={0}
      role="slider"
      aria-label={label}
      aria-orientation={axis === 'x' ? 'horizontal' : 'vertical'}
      aria-valuemin={roundTo(min, MM_DIGITS)}
      aria-valuemax={roundTo(max, MM_DIGITS)}
      aria-valuenow={shown}
      aria-valuetext={axis === 'x' ? t.seamFromLeft(String(shown)) : t.seamFromBottom(String(shown))}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}

export function TileSeamHandles({ page, positions, names, view, onChange }: TileSeamHandlesProps) {
  const handles = (axis: SeamAxis) => {
    const list = axis === 'x' ? positions.x : positions.y;
    const length = axis === 'x' ? page.widthMm : page.heightMm;
    return list.map((value, index) => {
      const [a, b] = (axis === 'x' ? names.x : names.y)[index] ?? [String(index + 1), String(index + 2)];
      const { min, max } = seamBounds(list, index, length);
      return (
        <SeamHandle
          key={`${axis}-${index}`}
          axis={axis}
          index={index}
          value={value}
          min={min}
          max={max}
          label={axis === 'x' ? t.seamColumns(a, b) : t.seamRows(a, b)}
          page={page}
          view={view}
          onChange={onChange}
        />
      );
    });
  };
  return (
    <g data-role="seam-handles">
      {handles('x')}
      {handles('y')}
    </g>
  );
}
