/** File-name filters for hot folders: basename globs and temp/partial-file detection. */

const REGEXP_SPECIAL = /[.+^${}()|[\]\\]/g;

/** Converts a basename glob (`*` = any run of characters, `?` = one character) to a RegExp. */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(REGEXP_SPECIAL, '\\$&');
  }
  return new RegExp(`^${source}$`, 'iu');
}

/** True when `fileName` matches at least one pattern (case-insensitive). */
export function matchesFilePatterns(fileName: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(fileName));
}

const TEMP_SUFFIXES = ['.tmp', '.temp', '.part', '.partial', '.crdownload', '.download', '.swp', '~'];

/**
 * Names that writers use while a file is incomplete, plus hidden files (ARCHITECTURE.md §9):
 * dotfiles, Office lock files (`~$name`), and common temp/partial suffixes.
 */
export function isTemporaryFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    lower.startsWith('.') ||
    lower.startsWith('~$') ||
    TEMP_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  );
}

/** True when a hot folder should consider `fileName` for intake. */
export function isCandidateFileName(fileName: string, patterns: readonly string[]): boolean {
  return !isTemporaryFileName(fileName) && matchesFilePatterns(fileName, patterns);
}
