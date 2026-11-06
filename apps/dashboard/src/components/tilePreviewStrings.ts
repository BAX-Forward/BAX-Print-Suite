/**
 * Strings for the opt-in tile preview (049a). Kept out of `strings.ts` so the
 * flag-off production build, including its source maps, stays byte-identical.
 */
export const tilePreviewStrings = {
  label: (columns: number, rows: number) => `Tile preview: ${columns} × ${rows} panels`,
  empty: 'No panels to preview.',
  dimensions: (width: string, height: string) => `${width} × ${height} mm`,
  panel: (label: string, dimensions: string) => `Panel ${label}, ${dimensions}`,
  // Job page section (049c).
  heading: 'Tiling',
  loading: 'Loading tile preview…',
  noTiling: 'No tiling set for this job.',
  noPages: 'This job has no pages to tile.',
  issuesHeading: 'The tiling cannot be laid out:',
  // Draggable seams (049d).
  editorLabel: 'Tile seam editor',
  seamColumns: (left: string, right: string) => `Seam between columns ${left} and ${right}`,
  seamRows: (upper: string, lower: string) => `Seam between rows ${upper} and ${lower}`,
  seamFromLeft: (mm: string) => `${mm} mm from the left edge`,
  seamFromBottom: (mm: string) => `${mm} mm from the bottom edge`,
  editHint:
    'Drag a seam, or focus it and use the arrow keys (1 mm, Shift for 10 mm), Home and End. Changes are local.',
  notSaved: 'Not saved',
  reset: 'Reset',
  sizesHeading: 'Panel sizes',
  panelSize: (label: string, dimensions: string) => `${label}: ${dimensions}`,
  lastValid: 'The drawing shows the last valid layout.',
};
