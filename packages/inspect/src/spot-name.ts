import { normalizeSpotName } from "@bax-print/core";

/**
 * Lookup key for a spot colour name. Same function as `normalizeSpotName` in core (also
 * re-exported by media), so preflight and the spot library always agree.
 */
export const spotNameKey: (name: string) => string = normalizeSpotName;
