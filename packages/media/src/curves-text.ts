import { type LinearizationCurves, ValidationError } from '@bax-print/core';
import { cgatsHeaderValue, cgatsNumber, cgatsRecords, formatCgatsNumber, parseCgats, serializeCgats } from './cgats.js';
import { normalizeContent } from './revisions.js';

export const LINEARIZATION_METRIC_KEYWORD = 'BPS_LINEARIZATION_METRIC';
const INPUT_FIELD = 'INPUT';

/**
 * Curves as CGATS-like text: one row per input step, an `INPUT` column (0..1) and one column per
 * colorant (0..1 device value). Six decimals, matching the precision kept in color setups.
 */
export function curvesToText(curves: LinearizationCurves, order?: readonly string[]): string {
  const names = Object.keys(curves.channels);
  const ordered = order ? [...order.filter((c) => names.includes(c)), ...names.filter((c) => !order.includes(c))] : names;
  return serializeCgats({
    identifier: 'CGATS.17',
    header: [
      { keyword: 'ORIGINATOR', value: 'BAX Print Suite' },
      { keyword: 'DESCRIPTOR', value: 'Linearization curves' },
      { keyword: 'KEYWORD', value: LINEARIZATION_METRIC_KEYWORD },
      { keyword: LINEARIZATION_METRIC_KEYWORD, value: curves.metric },
    ],
    fields: [INPUT_FIELD, ...ordered],
    rows: curves.inputs.map((input, i) => [
      formatCgatsNumber(input, 6),
      ...ordered.map((c) => formatCgatsNumber(curves.channels[c]![i]!, 6)),
    ]),
  });
}

export function curvesFromText(text: string): LinearizationCurves {
  const doc = parseCgats(text);
  if (doc.fields[0] !== INPUT_FIELD) throw new ValidationError(`curves text must start with an ${INPUT_FIELD} column`);
  const metric = cgatsHeaderValue(doc, LINEARIZATION_METRIC_KEYWORD);
  if (metric === undefined) throw new ValidationError(`curves text has no ${LINEARIZATION_METRIC_KEYWORD}`);
  const records = cgatsRecords(doc);
  const channels: Record<string, number[]> = {};
  for (const name of doc.fields.slice(1)) channels[name] = records.map((r) => cgatsNumber(r, name));
  const curves = {
    metric: metric as LinearizationCurves['metric'],
    inputs: records.map((r) => cgatsNumber(r, INPUT_FIELD)),
    channels,
  };
  // Reuse the color setup validation so imported curves obey the same rules as edited ones.
  return normalizeContent({ level: 'uncharacterized', renderingIntent: 'perceptual', curves }).curves as LinearizationCurves;
}
