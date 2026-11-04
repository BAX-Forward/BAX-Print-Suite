import {
  type Lab,
  type MeasurementCondition,
  MeasurementConditionMismatchError,
  ValidationError,
  isMeasurementCondition,
} from '@bax-print/core';
import { cgatsHeaderValue, cgatsNumber, cgatsRecords, formatCgatsNumber, parseCgats, serializeCgats } from './cgats.js';
import { xyzToLab } from './color/lab.js';
import { readCxfLab } from './cxf.js';

/** Our CGATS keyword for the ISO 13655 condition (declared with `KEYWORD` in files we write). */
export const MEASUREMENT_CONDITION_KEYWORD = 'MEASUREMENT_CONDITION';

export interface MeasuredPatchRecord {
  id: string;
  lab: Lab;
}

export interface MeasurementSet {
  condition: MeasurementCondition;
  source: 'cgats' | 'cxf' | 'instrument';
  instrument?: string;
  patches: MeasuredPatchRecord[];
}

/**
 * The condition stated in the file wins only if it agrees with the one the operator stated.
 * One of the two is required: an unstated condition cannot be checked against the session.
 */
export function resolveCondition(fromFile: string | undefined, stated: MeasurementCondition | undefined): MeasurementCondition {
  if (fromFile !== undefined && !isMeasurementCondition(fromFile)) {
    throw new ValidationError(`unknown measurement condition ${fromFile}; expected M0, M1 or M2`);
  }
  if (stated !== undefined && !isMeasurementCondition(stated)) {
    throw new ValidationError(`unknown measurement condition ${String(stated)}; expected M0, M1 or M2`);
  }
  if (fromFile !== undefined && stated !== undefined && fromFile !== stated) {
    throw new MeasurementConditionMismatchError(stated, fromFile);
  }
  const condition = fromFile ?? stated;
  if (condition === undefined) throw new ValidationError('the measurement condition (M0, M1 or M2) is required');
  return condition;
}

function uniquePatches(patches: MeasuredPatchRecord[]): MeasuredPatchRecord[] {
  const seen = new Set<string>();
  for (const patch of patches) {
    if (seen.has(patch.id)) throw new ValidationError(`patch ${patch.id} is measured twice`);
    seen.add(patch.id);
    if (![patch.lab.L, patch.lab.a, patch.lab.b].every(Number.isFinite)) {
      throw new ValidationError(`patch ${patch.id} has a non-finite Lab value`);
    }
  }
  return patches;
}

/** CGATS.17 with SAMPLE_ID and LAB_L/LAB_A/LAB_B, or XYZ_X/XYZ_Y/XYZ_Z on a 0..100 scale (converted to D50 Lab). */
export function measurementsFromCgats(text: string, options: { condition?: MeasurementCondition } = {}): MeasurementSet {
  const doc = parseCgats(text);
  if (!doc.fields.includes('SAMPLE_ID')) throw new ValidationError('the measurement file has no SAMPLE_ID field');
  const hasLab = ['LAB_L', 'LAB_A', 'LAB_B'].every((f) => doc.fields.includes(f));
  const hasXyz = ['XYZ_X', 'XYZ_Y', 'XYZ_Z'].every((f) => doc.fields.includes(f));
  if (!hasLab && !hasXyz) throw new ValidationError('the measurement file has neither LAB_* nor XYZ_* fields');
  const patches = cgatsRecords(doc).map((record): MeasuredPatchRecord => {
    const id = record.SAMPLE_ID!;
    const lab = hasLab
      ? { L: cgatsNumber(record, 'LAB_L'), a: cgatsNumber(record, 'LAB_A'), b: cgatsNumber(record, 'LAB_B') }
      : xyzToLab({
          X: cgatsNumber(record, 'XYZ_X') / 100,
          Y: cgatsNumber(record, 'XYZ_Y') / 100,
          Z: cgatsNumber(record, 'XYZ_Z') / 100,
        });
    return { id, lab };
  });
  const condition = resolveCondition(cgatsHeaderValue(doc, MEASUREMENT_CONDITION_KEYWORD), options.condition);
  return { condition, source: 'cgats', patches: uniquePatches(patches) };
}

/** ISO 17972 (CxF/X) Lab values. CxF files carry no condition we read, so it must be stated. */
export function measurementsFromCxf(text: string, options: { condition?: MeasurementCondition } = {}): MeasurementSet {
  const objects = readCxfLab(text);
  const condition = resolveCondition(undefined, options.condition);
  return {
    condition,
    source: 'cxf',
    patches: uniquePatches(objects.map((o) => ({ id: o.id, lab: { L: o.L, a: o.a, b: o.b } }))),
  };
}

export function measurementsToCgats(set: MeasurementSet, descriptor = 'Measurements'): string {
  return serializeCgats({
    identifier: 'CGATS.17',
    header: [
      { keyword: 'ORIGINATOR', value: 'BAX Print Suite' },
      { keyword: 'DESCRIPTOR', value: descriptor.replace(/"/g, "'") },
      { keyword: 'KEYWORD', value: MEASUREMENT_CONDITION_KEYWORD },
      { keyword: MEASUREMENT_CONDITION_KEYWORD, value: set.condition },
    ],
    fields: ['SAMPLE_ID', 'LAB_L', 'LAB_A', 'LAB_B'],
    rows: set.patches.map((p) => [p.id, formatCgatsNumber(p.lab.L, 4), formatCgatsNumber(p.lab.a, 4), formatCgatsNumber(p.lab.b, 4)]),
  });
}
