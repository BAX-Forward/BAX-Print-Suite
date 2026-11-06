import { mmToPt, tile } from '@bax-print/tile/layout';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobTiling } from '../src/api/tiling';
import type { Page } from '../src/api/types';
import { artworkPage, editedSpec, JobTileSection, movedSeams, tileSpec } from '../src/components/JobTileSection';
import { TilePreview } from '../src/components/TilePreview';
import { keyedPosition, LARGE_STEP_MM, seamBounds, STEP_MM } from '../src/components/TileSeamHandles';
import { tilePreviewStrings } from '../src/components/tilePreviewStrings';

/**
 * Spec 049d: draggable seams in the job page's tile section. The edit is local: every move re-runs
 * tile() with explicit seams, invalid moves list tile's issues over the last valid drawing, and
 * Reset restores the job's tiling. __BPS_TILE_PREVIEW__ is false in vitest, so JobTileSection is
 * rendered directly, as the flag-on JobDetailTilePage does.
 */

const t = tilePreviewStrings;

/** A 3000 × 2000 mm page without a TrimBox: seams at x 1000 and 2000, y 1000. */
const PAGE: Page = { index: 0, widthPt: mmToPt(3000), heightPt: mmToPt(2000), trimBox: null };
const OVERLAP_3X2: JobTiling = { grid: { columns: 3, rows: 2 }, seam: { kind: 'overlap', overlapMm: 20 } };
const BASE = tile(artworkPage(PAGE), tileSpec(OVERLAP_3X2));

const COLUMN_SEAM_1 = t.seamColumns('1', '2');
const COLUMN_SEAM_2 = t.seamColumns('2', '3');
const ROW_SEAM = t.seamRows('A', 'B');

/** Fires pointer events with clientX/clientY even if this jsdom has no PointerEvent. */
beforeAll(() => {
  const view = document.defaultView;
  if (view === null || 'PointerEvent' in view) return;
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  Object.defineProperty(view, 'PointerEvent', { value: TestPointerEvent, configurable: true, writable: true });
});

/**
 * jsdom has no layout: give the editor's SVG a drawn size. The view box is 3120 × 2120 mm (60 mm
 * margin), so at 312 × 212 px one pixel is 10 mm.
 */
function stubDrawnSize(svg: HTMLElement) {
  const box = { x: 0, y: 0, left: 0, top: 0, width: 312, height: 212, right: 312, bottom: 212, toJSON: () => ({}) };
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(box);
}

function renderEditor() {
  render(<JobTileSection job={{ pages: [PAGE], tiling: OVERLAP_3X2 }} />);
  const section = screen.getByRole('region', { name: t.heading });
  const editor = within(section).getByRole('group', { name: t.editorLabel });
  const slider = (name: string) => within(editor).getByRole('slider', { name });
  /** The size list entry of a panel. */
  const size = (id: string) => section.querySelector(`[data-panel-size="${id}"]`)?.textContent;
  /** The size text drawn in a panel. */
  const drawn = (id: string) =>
    editor.querySelector(`g[data-panel-id="${id}"] text[data-role="dimensions"]`)?.textContent;
  const issues = () => [...section.querySelectorAll('[data-issue]')].map((item) => item.getAttribute('data-issue'));
  return { section, editor, slider, size, drawn, issues };
}

describe('JobTileSection seam editor', () => {
  it('names each internal seam as a slider in mm', () => {
    const { editor, slider } = renderEditor();
    expect(within(editor).getAllByRole('slider').map((handle) => handle.getAttribute('aria-label'))).toEqual([
      COLUMN_SEAM_1,
      COLUMN_SEAM_2,
      ROW_SEAM,
    ]);
    const first = slider(COLUMN_SEAM_1);
    expect(first).toHaveAttribute('tabindex', '0');
    expect(first).toHaveAttribute('aria-valuenow', '1000');
    expect(first).toHaveAttribute('aria-valuemin', '0');
    expect(first).toHaveAttribute('aria-valuemax', '2000');
    expect(first).toHaveAttribute('aria-valuetext', t.seamFromLeft('1000'));
    expect(slider(COLUMN_SEAM_2)).toHaveAttribute('aria-valuemin', '1000');
    expect(slider(COLUMN_SEAM_2)).toHaveAttribute('aria-valuemax', '3000');
    expect(slider(ROW_SEAM)).toHaveAttribute('aria-valuetext', t.seamFromBottom('1000'));
    // The drawing itself stays an image with its own name.
    expect(within(editor).getByRole('img', { name: t.label(3, 2) })).toBeInTheDocument();
  });

  it('says the edit is not saved and starts with Reset disabled', () => {
    const { section } = renderEditor();
    expect(section.querySelector('[data-tile-edit-status]')).toHaveTextContent(t.notSaved);
    expect(within(section).getByRole('button', { name: t.reset })).toBeDisabled();
    expect(within(section).getByRole('list', { name: t.sizesHeading })).toBeInTheDocument();
  });

  it('nudges a seam 1 mm with an arrow key and 10 mm with Shift', () => {
    const { slider, size, drawn } = renderEditor();
    const seam = slider(COLUMN_SEAM_1);
    expect(size('1-1')).toBe(t.panelSize('A1', t.dimensions('1020', '1020')));

    fireEvent.keyDown(seam, { key: 'ArrowRight' });
    expect(seam).toHaveAttribute('aria-valuenow', '1001');
    expect(seam).toHaveAttribute('aria-valuetext', t.seamFromLeft('1001'));
    expect(size('1-1')).toBe(t.panelSize('A1', t.dimensions('1021', '1020')));
    // A2 loses the millimetre: 999 mm visible plus 20 mm overlap each side.
    expect(size('1-2')).toBe(t.panelSize('A2', t.dimensions('1039', '1020')));
    expect(drawn('1-1')).toBe(t.dimensions('1021', '1020'));

    fireEvent.keyDown(seam, { key: 'ArrowLeft', shiftKey: true });
    expect(seam).toHaveAttribute('aria-valuenow', '991');
    expect(size('1-1')).toBe(t.panelSize('A1', t.dimensions('1011', '1020')));
  });

  it('moves a horizontal seam up with ArrowUp', () => {
    const { slider, size } = renderEditor();
    const seam = slider(ROW_SEAM);
    fireEvent.keyDown(seam, { key: 'ArrowUp' });
    expect(seam).toHaveAttribute('aria-valuenow', '1001');
    // The top row shrinks, the bottom row grows.
    expect(size('1-1')).toBe(t.panelSize('A1', t.dimensions('1020', '1019')));
    expect(size('2-1')).toBe(t.panelSize('B1', t.dimensions('1020', '1021')));
  });

  it('ignores keys other than arrows, Home and End', () => {
    const { slider, section } = renderEditor();
    fireEvent.keyDown(slider(COLUMN_SEAM_1), { key: 'a' });
    expect(slider(COLUMN_SEAM_1)).toHaveAttribute('aria-valuenow', '1000');
    expect(within(section).getByRole('button', { name: t.reset })).toBeDisabled();
  });

  it('clamps Home and End to the neighbouring seams and shows tile’s issue there', () => {
    const { slider, size, drawn, issues, section } = renderEditor();
    const seam = slider(COLUMN_SEAM_1);

    fireEvent.keyDown(seam, { key: 'Home' });
    expect(seam).toHaveAttribute('aria-valuenow', '0');
    fireEvent.keyDown(seam, { key: 'ArrowLeft' });
    expect(seam).toHaveAttribute('aria-valuenow', '0');
    // A seam on the artwork edge is not a valid seam for tile().
    expect(issues()).toEqual(['invalid-seam']);

    fireEvent.keyDown(seam, { key: 'End' });
    expect(seam).toHaveAttribute('aria-valuenow', '2000');
    fireEvent.keyDown(seam, { key: 'ArrowRight', shiftKey: true });
    expect(seam).toHaveAttribute('aria-valuenow', '2000');
    expect(issues()).toEqual(['invalid-seam']);

    // The last valid layout stays drawn and listed.
    expect(section).toHaveTextContent(t.lastValid);
    expect(drawn('1-1')).toBe(t.dimensions('1020', '1020'));
    expect(size('1-1')).toBe(t.panelSize('A1', t.dimensions('1020', '1020')));
  });

  it('lists tile’s issue for a panel narrower than the overlap, keeping the last valid drawing', () => {
    const { slider, section, size, drawn } = renderEditor();
    const seam = slider(COLUMN_SEAM_1);
    fireEvent.keyDown(seam, { key: 'ArrowRight' });
    fireEvent.keyDown(seam, { key: 'End' });
    fireEvent.keyDown(seam, { key: 'ArrowLeft', shiftKey: true });

    const [, second = 0] = BASE.seamsX;
    const positions = movedSeams({ x: BASE.seamsX, y: BASE.seamsY }, 'x', 0, second - LARGE_STEP_MM);
    const expected = tile(artworkPage(PAGE), editedSpec(OVERLAP_3X2, positions)).issues;
    // A2 is 10 mm wide, narrower than the 20 mm overlap at both of its seams.
    expect(expected.map((issue) => issue.code)).toEqual(['overlap-exceeds-panel', 'overlap-exceeds-panel']);

    expect(seam).toHaveAttribute('aria-valuenow', '1990');
    const list = section.querySelector('[data-tile-issues]');
    expect(list).toHaveTextContent(t.issuesHeading);
    expect([...section.querySelectorAll('[data-issue]')].map((item) => item.textContent)).toEqual(
      expected.map((issue) => issue.message),
    );
    // The 1 mm nudge was the last valid layout.
    expect(drawn('1-1')).toBe(t.dimensions('1021', '1020'));
    expect(size('1-1')).toBe(t.panelSize('A1', t.dimensions('1021', '1020')));

    // A valid move clears the issues: at 1970 mm A2 is 30 mm wide.
    fireEvent.keyDown(seam, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(seam, { key: 'ArrowLeft', shiftKey: true });
    expect(seam).toHaveAttribute('aria-valuenow', '1970');
    expect(section.querySelector('[data-tile-issues]')).toBeNull();
    expect(section).not.toHaveTextContent(t.lastValid);
    expect(size('1-1')).toBe(t.panelSize('A1', t.dimensions('1990', '1020')));
  });

  it('drags seams with the pointer, capturing it, and stops on pointerup', () => {
    const { editor, slider, size } = renderEditor();
    stubDrawnSize(editor);

    const seam = slider(COLUMN_SEAM_1);
    const capture = vi.fn();
    seam.setPointerCapture = capture;
    fireEvent.pointerDown(seam, { pointerId: 7, button: 0, clientX: 100, clientY: 100 });
    expect(capture).toHaveBeenCalledWith(7);
    expect(seam).toHaveFocus();
    fireEvent.pointerMove(seam, { pointerId: 7, clientX: 105, clientY: 100 });
    expect(seam).toHaveAttribute('aria-valuenow', '1050');
    expect(size('1-1')).toBe(t.panelSize('A1', t.dimensions('1070', '1020')));
    // Another pointer does not move this seam.
    fireEvent.pointerMove(seam, { pointerId: 8, clientX: 150, clientY: 100 });
    expect(seam).toHaveAttribute('aria-valuenow', '1050');
    fireEvent.pointerUp(seam, { pointerId: 7, clientX: 105, clientY: 100 });
    fireEvent.pointerMove(seam, { pointerId: 7, clientX: 120, clientY: 100 });
    expect(seam).toHaveAttribute('aria-valuenow', '1050');

    // Up on screen is up in the artwork frame: 3 px up raises the row seam 30 mm.
    const row = slider(ROW_SEAM);
    row.setPointerCapture = vi.fn();
    fireEvent.pointerDown(row, { pointerId: 9, button: 0, clientX: 50, clientY: 100 });
    fireEvent.pointerMove(row, { pointerId: 9, clientX: 50, clientY: 97 });
    fireEvent.pointerUp(row, { pointerId: 9, clientX: 50, clientY: 97 });
    expect(row).toHaveAttribute('aria-valuenow', '1030');
    expect(size('1-1')).toBe(t.panelSize('A1', t.dimensions('1070', '990')));
  });

  it('clamps a drag to the neighbouring seam', () => {
    const { editor, slider, issues } = renderEditor();
    stubDrawnSize(editor);
    const seam = slider(COLUMN_SEAM_1);
    seam.setPointerCapture = vi.fn();
    fireEvent.pointerDown(seam, { pointerId: 1, button: 0, clientX: 100, clientY: 0 });
    fireEvent.pointerMove(seam, { pointerId: 1, clientX: 400, clientY: 0 });
    expect(seam).toHaveAttribute('aria-valuenow', '2000');
    expect(issues()).toEqual(['invalid-seam']);
  });

  it('ignores a secondary-button pointerdown', () => {
    const { editor, slider } = renderEditor();
    stubDrawnSize(editor);
    const seam = slider(COLUMN_SEAM_1);
    const capture = vi.fn();
    seam.setPointerCapture = capture;
    fireEvent.pointerDown(seam, { pointerId: 1, button: 2, clientX: 100, clientY: 0 });
    fireEvent.pointerMove(seam, { pointerId: 1, clientX: 110, clientY: 0 });
    expect(capture).not.toHaveBeenCalled();
    expect(seam).toHaveAttribute('aria-valuenow', '1000');
  });

  it('restores the job’s tiling on Reset', () => {
    const { section, slider, size, issues } = renderEditor();
    fireEvent.keyDown(slider(COLUMN_SEAM_2), { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(slider(COLUMN_SEAM_1), { key: 'Home' });
    expect(issues()).toEqual(['invalid-seam']);
    const reset = within(section).getByRole('button', { name: t.reset });
    expect(reset).toBeEnabled();

    fireEvent.click(reset);
    expect(slider(COLUMN_SEAM_1)).toHaveAttribute('aria-valuenow', '1000');
    expect(slider(COLUMN_SEAM_2)).toHaveAttribute('aria-valuenow', '2000');
    expect(issues()).toEqual([]);
    expect(size('1-2')).toBe(t.panelSize('A2', t.dimensions('1040', '1020')));
    expect(reset).toBeDisabled();
  });

  it('makes no network request while editing', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const { section, editor, slider } = renderEditor();
    stubDrawnSize(editor);
    const seam = slider(COLUMN_SEAM_1);
    seam.setPointerCapture = vi.fn();

    fireEvent.keyDown(seam, { key: 'ArrowRight' });
    fireEvent.keyDown(seam, { key: 'Home' });
    fireEvent.pointerDown(seam, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(seam, { pointerId: 1, clientX: 50, clientY: 0 });
    fireEvent.pointerUp(seam, { pointerId: 1, clientX: 50, clientY: 0 });
    fireEvent.click(within(section).getByRole('button', { name: t.reset }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
  });
});

describe('TilePreview without seams', () => {
  it('stays a read-only image with no sliders', () => {
    const page = artworkPage(PAGE);
    const { container } = render(<TilePreview page={page} tiling={BASE} />);
    expect(screen.getByRole('img', { name: t.label(3, 2) })).toBeInTheDocument();
    expect(screen.queryAllByRole('slider')).toEqual([]);
    expect(container.querySelector('[data-tile-editor], [data-seam-handle]')).toBeNull();
  });
});

describe('seam keyboard and bounds', () => {
  it('steps, clamps and jumps', () => {
    expect(keyedPosition('ArrowRight', false, 10, 0, 100)).toBe(10 + STEP_MM);
    expect(keyedPosition('ArrowUp', true, 10, 0, 100)).toBe(10 + LARGE_STEP_MM);
    expect(keyedPosition('ArrowDown', false, 10, 0, 100)).toBe(10 - STEP_MM);
    expect(keyedPosition('ArrowLeft', true, 5, 0, 100)).toBe(0);
    expect(keyedPosition('ArrowRight', true, 95, 0, 100)).toBe(100);
    expect(keyedPosition('Home', false, 40, 20, 60)).toBe(20);
    expect(keyedPosition('End', false, 40, 20, 60)).toBe(60);
    expect(keyedPosition('Enter', false, 40, 20, 60)).toBeUndefined();
  });

  it('bounds a seam by its neighbours or the artwork edges', () => {
    expect(seamBounds([100, 200, 300], 0, 400)).toEqual({ min: 0, max: 200 });
    expect(seamBounds([100, 200, 300], 1, 400)).toEqual({ min: 100, max: 300 });
    expect(seamBounds([100, 200, 300], 2, 400)).toEqual({ min: 200, max: 400 });
  });
});
