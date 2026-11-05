/**
 * Lookup key for a spot colour name: Unicode NFC, whitespace runs collapsed, trimmed, lower case.
 * The single shared rule for spot libraries (media) and preflight spot checks (inspect).
 */
export function normalizeSpotName(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}
