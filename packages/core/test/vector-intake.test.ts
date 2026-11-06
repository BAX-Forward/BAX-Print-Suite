import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOT_FOLDER_SETTINGS,
  RASTER_FILE_PATTERNS,
  SOURCE_FORMATS,
  VECTOR_FILE_PATTERNS,
  effectiveFilePatterns,
  sniffSourceFormat,
  withHotFolderDefaults,
} from '../src/index.js';

describe('Spec 035b hot folder vector settings', () => {
  it('leaves acceptVector off by default and keeps the stored shape unchanged', () => {
    const settings = withHotFolderDefaults();
    expect(settings.acceptVector).toBeUndefined();
    expect('acceptVector' in settings).toBe(false);
    expect('acceptVector' in DEFAULT_HOT_FOLDER_SETTINGS).toBe(false);
    expect(withHotFolderDefaults({ acceptVector: false })).toEqual(withHotFolderDefaults());
  });

  it('keeps acceptVector when it is turned on, independently of acceptRaster', () => {
    expect(withHotFolderDefaults({ acceptVector: true }).acceptVector).toBe(true);
    expect('acceptRaster' in withHotFolderDefaults({ acceptVector: true })).toBe(false);
  });

  it('matches only filePatterns when acceptVector is off', () => {
    expect(effectiveFilePatterns({ filePatterns: ['*.pdf'], acceptVector: false })).toEqual(['*.pdf']);
    expect(effectiveFilePatterns({ filePatterns: ['*.pdf'], acceptRaster: true })).toEqual(['*.pdf', ...RASTER_FILE_PATTERNS]);
  });

  it('adds the vector patterns without duplicates when acceptVector is on', () => {
    expect(effectiveFilePatterns({ filePatterns: ['*.pdf'], acceptVector: true })).toEqual(['*.pdf', ...VECTOR_FILE_PATTERNS]);
    expect(effectiveFilePatterns({ filePatterns: ['*.SVG', '*.pdf'], acceptVector: true })).toEqual(['*.SVG', '*.pdf', '*.dxf']);
    expect(effectiveFilePatterns({ filePatterns: ['*.pdf'], acceptRaster: true, acceptVector: true })).toEqual([
      '*.pdf',
      ...RASTER_FILE_PATTERNS,
      ...VECTOR_FILE_PATTERNS,
    ]);
  });

  it('lists the SVG and DXF globs and the svg and dxf source formats', () => {
    expect(VECTOR_FILE_PATTERNS).toEqual(['*.svg', '*.dxf']);
    expect(SOURCE_FORMATS).toEqual(expect.arrayContaining(['svg', 'dxf']));
  });

  it('leaves SVG and DXF to the vector header reader: magic-byte sniffing does not detect them', () => {
    expect(sniffSourceFormat(new TextEncoder().encode('<svg width="1in" height="1in"/>'))).toBeUndefined();
    expect(sniffSourceFormat(new TextEncoder().encode('  0\nSECTION\n  2\nHEADER\n'))).toBeUndefined();
  });
});
