import { describe, expect, it } from 'vitest';
import { globToRegExp, isCandidateFileName, isTemporaryFileName, matchesFilePatterns } from '../src/index.js';

describe('hot folder file patterns', () => {
  it('matches basename globs case-insensitively', () => {
    expect(matchesFilePatterns('Artwork.PDF', ['*.pdf'])).toBe(true);
    expect(matchesFilePatterns('artwork.pdf.txt', ['*.pdf'])).toBe(false);
    expect(matchesFilePatterns('job-7.pdf', ['job-?.pdf'])).toBe(true);
    expect(matchesFilePatterns('job-17.pdf', ['job-?.pdf'])).toBe(false);
    expect(matchesFilePatterns('a.eps', ['*.pdf', '*.eps'])).toBe(true);
    expect(matchesFilePatterns('a.pdf', [])).toBe(false);
  });

  it('treats regular expression characters in patterns literally', () => {
    expect(globToRegExp('a+b(1).pdf').test('a+b(1).pdf')).toBe(true);
    expect(globToRegExp('a.pdf').test('aXpdf')).toBe(false);
    expect(globToRegExp('[x].pdf').test('x.pdf')).toBe(false);
    expect(globToRegExp('$^.pdf').test('$^.pdf')).toBe(true);
  });

  it('flags hidden, lock and partial-write names as temporary', () => {
    for (const name of ['.DS_Store', '~$order.docx', 'a.pdf.tmp', 'a.pdf.part', 'a.PDF.crdownload', 'a.pdf~']) {
      expect(isTemporaryFileName(name), name).toBe(true);
    }
    expect(isTemporaryFileName('order.pdf')).toBe(false);
  });

  it('accepts only matching, non-temporary names as intake candidates', () => {
    expect(isCandidateFileName('order.pdf', ['*.pdf'])).toBe(true);
    expect(isCandidateFileName('.order.pdf', ['*.pdf'])).toBe(false);
    expect(isCandidateFileName('order.pdf.part', ['*.pdf', '*.part'])).toBe(false);
    expect(isCandidateFileName('order.eps', ['*.pdf'])).toBe(false);
  });
});
