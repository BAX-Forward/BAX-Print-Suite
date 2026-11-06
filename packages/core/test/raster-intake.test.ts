import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOT_FOLDER_SETTINGS,
  RASTER_FILE_PATTERNS,
  effectiveFilePatterns,
  sniffSourceFormat,
  withHotFolderDefaults,
} from '../src/index.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

describe('Spec 031c hot folder raster settings', () => {
  it('leaves acceptRaster off by default and keeps the stored shape unchanged', () => {
    const settings = withHotFolderDefaults();
    expect(settings.acceptRaster).toBeUndefined();
    expect('acceptRaster' in settings).toBe(false);
    expect('acceptRaster' in DEFAULT_HOT_FOLDER_SETTINGS).toBe(false);
    expect(withHotFolderDefaults({ acceptRaster: false })).toEqual(withHotFolderDefaults());
  });

  it('keeps acceptRaster when it is turned on', () => {
    expect(withHotFolderDefaults({ acceptRaster: true }).acceptRaster).toBe(true);
  });

  it('matches only filePatterns when acceptRaster is off, raster globs included', () => {
    expect(effectiveFilePatterns({ filePatterns: ['*.pdf'] })).toEqual(['*.pdf']);
    expect(effectiveFilePatterns({ filePatterns: ['*.pdf', '*.png'], acceptRaster: false })).toEqual(['*.pdf', '*.png']);
  });

  it('adds the raster patterns without duplicates when acceptRaster is on', () => {
    expect(effectiveFilePatterns({ filePatterns: ['*.pdf'], acceptRaster: true })).toEqual(['*.pdf', ...RASTER_FILE_PATTERNS]);
    expect(effectiveFilePatterns({ filePatterns: ['*.PNG', '*.pdf', '*.tif'], acceptRaster: true })).toEqual([
      '*.PNG',
      '*.pdf',
      '*.tif',
      '*.tiff',
      '*.jpg',
      '*.jpeg',
    ]);
  });

  it('lists the TIFF, JPEG and PNG globs', () => {
    expect(RASTER_FILE_PATTERNS).toEqual(['*.tif', '*.tiff', '*.jpg', '*.jpeg', '*.png']);
  });
});

describe('sniffSourceFormat', () => {
  it('detects PDF, PNG, JPEG and both TIFF byte orders', () => {
    expect(sniffSourceFormat(new TextEncoder().encode('%PDF-1.7\n'))).toBe('pdf');
    expect(sniffSourceFormat(PNG)).toBe('png');
    expect(sniffSourceFormat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffSourceFormat(Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 0x08]))).toBe('tiff');
    expect(sniffSourceFormat(Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a, 0x00]))).toBe('tiff');
  });

  it('returns undefined for unknown or truncated bytes', () => {
    expect(sniffSourceFormat(new Uint8Array())).toBeUndefined();
    expect(sniffSourceFormat(new TextEncoder().encode('%PD'))).toBeUndefined();
    expect(sniffSourceFormat(PNG.subarray(0, 4))).toBeUndefined();
    expect(sniffSourceFormat(new TextEncoder().encode('GIF89a'))).toBeUndefined();
  });
});
