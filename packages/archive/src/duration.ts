import { DAY_MS, InvalidArgumentError } from '@bax-print/core';

const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: DAY_MS,
  w: 7 * DAY_MS,
} as const;

const SHORT_FORM = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i;
const ISO_FORM = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;

/** Parses `14d`, `12h`, `90m` or an ISO 8601 duration such as `P14D` / `PT36H` into milliseconds. */
export function parseDuration(text: string): number {
  const trimmed = text.trim();
  let ms: number | undefined;

  const short = SHORT_FORM.exec(trimmed);
  if (short) {
    const [, amount, unit] = short;
    if (amount !== undefined && unit !== undefined) {
      ms = Number(amount) * UNIT_MS[unit.toLowerCase() as keyof typeof UNIT_MS];
    }
  } else {
    const iso = ISO_FORM.exec(trimmed);
    if (iso && iso.slice(1).some((part) => part !== undefined)) {
      const [weeks = 0, days = 0, hours = 0, minutes = 0, seconds = 0] = iso
        .slice(1)
        .map((part) => Number(part ?? 0));
      ms = weeks * UNIT_MS.w + days * UNIT_MS.d + hours * UNIT_MS.h + minutes * UNIT_MS.m + seconds * UNIT_MS.s;
    }
  }

  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    throw new InvalidArgumentError(`unrecognised or non-positive duration: ${JSON.stringify(text)}`);
  }
  return ms;
}
