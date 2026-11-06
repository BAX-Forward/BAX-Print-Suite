/**
 * Strings for the opt-in tile preview (049a). Kept out of `strings.ts` so the
 * flag-off production build, including its source maps, stays byte-identical.
 */
export const tilePreviewStrings = {
  label: (columns: number, rows: number) => `Tile preview: ${columns} × ${rows} panels`,
  empty: 'No panels to preview.',
  dimensions: (width: string, height: string) => `${width} × ${height} mm`,
  panel: (label: string, dimensions: string) => `Panel ${label}, ${dimensions}`,
};
