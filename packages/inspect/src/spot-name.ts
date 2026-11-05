/**
 * Lookup key for a spot colour name: Unicode NFC, whitespace runs collapsed, trimmed, lower case.
 * Must give the same result as `normalizeSpotName` in `@bax-print/media` (spot-library.ts), which
 * keys the shop's spot library; it is repeated here so that inspect does not depend on media.
 */
export function spotNameKey(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}
