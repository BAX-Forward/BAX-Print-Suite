import {
  CHARACTERIZATION_LEVELS,
  type CharacterizationLevel,
  type ColorSetup,
  type ColorSetupContent,
  type ColorSetupRevisionRecord,
  LINEARIZATION_METRICS,
  type LinearizationCurves,
  type LinearizationMetric,
  type StoredProfileRef,
  type RevisionAuthorKind,
  ValidationError,
  isRenderingIntent,
} from '@bax-print/core';
import { roundTo } from './color/linearization.js';
import { contentHash } from './hash.js';
import { COLORANT_ID, isFiniteNumber, normalizeColorants, requireText } from './validate.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

function normalizeCurves(curves: LinearizationCurves): LinearizationCurves {
  if (curves === null || typeof curves !== 'object') throw new ValidationError('curves must be an object');
  if (!(LINEARIZATION_METRICS as readonly string[]).includes(curves.metric)) {
    throw new ValidationError(`unknown linearization metric ${String(curves.metric)}`);
  }
  if (!Array.isArray(curves.inputs) || curves.inputs.length < 2 || !curves.inputs.every(isFiniteNumber)) {
    throw new ValidationError('curve inputs must be at least two finite numbers');
  }
  const inputs = curves.inputs.map((v) => roundTo(v));
  if (inputs[0] !== 0 || inputs[inputs.length - 1] !== 1) throw new ValidationError('curve inputs must run from 0 to 1');
  for (let i = 1; i < inputs.length; i++) {
    if (inputs[i]! <= inputs[i - 1]!) throw new ValidationError('curve inputs must be strictly increasing');
  }
  const names = Object.keys(curves.channels ?? {});
  if (names.length === 0) throw new ValidationError('curves need at least one channel');
  const channels: Record<string, number[]> = {};
  for (const name of names) {
    if (!COLORANT_ID.test(name)) throw new ValidationError(`invalid colorant id ${name} in curves`);
    const values = curves.channels[name];
    if (!Array.isArray(values) || values.length !== inputs.length || !values.every(isFiniteNumber)) {
      throw new ValidationError(`curve ${name} must have one finite value per input`);
    }
    const rounded = values.map((v) => roundTo(v));
    if (rounded.some((v, i) => v < 0 || v > 1 || (i > 0 && v < rounded[i - 1]!))) {
      throw new ValidationError(`curve ${name} must be non-decreasing within 0..1`);
    }
    channels[name] = rounded;
  }
  return { metric: curves.metric as LinearizationMetric, inputs, channels };
}

function normalizeLimits(limits: Record<string, number>): Record<string, number> {
  if (limits === null || typeof limits !== 'object') throw new ValidationError('channelLimitsPercent must be an object');
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(limits)) {
    if (!COLORANT_ID.test(name)) throw new ValidationError(`invalid colorant id ${name} in channel limits`);
    if (!isFiniteNumber(value) || value <= 0 || value > 100) {
      throw new ValidationError(`channel limit for ${name} must be within (0, 100]`);
    }
    out[name] = roundTo(value, 4);
  }
  return out;
}

function normalizeProfileRef(ref: StoredProfileRef): StoredProfileRef {
  if (ref === null || typeof ref !== 'object') throw new ValidationError('outputProfile must be an object');
  if (typeof ref.sha256 !== 'string' || !SHA256_HEX.test(ref.sha256)) {
    throw new ValidationError('outputProfile.sha256 must be a lowercase SHA-256 hex digest');
  }
  if (ref.format !== 'icc' && ref.format !== 'other') throw new ValidationError('outputProfile.format must be icc or other');
  const provenance = ref.provenance;
  if (provenance === null || typeof provenance !== 'object' || typeof provenance.redistributable !== 'boolean') {
    throw new ValidationError('outputProfile.provenance must state source, license and redistributable');
  }
  return {
    sha256: ref.sha256,
    description: requireText(ref.description, 'outputProfile.description'),
    format: ref.format,
    mediaType: requireText(ref.mediaType, 'outputProfile.mediaType'),
    colorants: normalizeColorants(ref.colorants, 'outputProfile.colorants'),
    provenance: {
      source: requireText(provenance.source, 'outputProfile.provenance.source'),
      license: requireText(provenance.license, 'outputProfile.provenance.license'),
      redistributable: provenance.redistributable,
    },
  };
}

/**
 * Validates color setup content and returns a fresh, normalized copy (curves rounded to six
 * decimals so they round-trip through text exactly). Each level requires the corrections it adds.
 */
export function normalizeContent(content: ColorSetupContent): ColorSetupContent {
  if (content === null || typeof content !== 'object') throw new ValidationError('content must be an object');
  if (!(CHARACTERIZATION_LEVELS as readonly string[]).includes(content.level)) {
    throw new ValidationError(`level must be one of ${CHARACTERIZATION_LEVELS.join(', ')}`);
  }
  if (!isRenderingIntent(content.renderingIntent)) throw new ValidationError('renderingIntent is not an ICC rendering intent');
  const level: CharacterizationLevel = content.level;
  const out: ColorSetupContent = { level, renderingIntent: content.renderingIntent };
  if (content.curves !== undefined) out.curves = normalizeCurves(content.curves);
  if (content.channelLimitsPercent !== undefined) out.channelLimitsPercent = normalizeLimits(content.channelLimitsPercent);
  if (content.tacLimitPercent !== undefined) {
    if (!isFiniteNumber(content.tacLimitPercent) || content.tacLimitPercent <= 0) {
      throw new ValidationError('tacLimitPercent must be a positive number');
    }
    out.tacLimitPercent = roundTo(content.tacLimitPercent, 4);
  }
  if (content.outputProfile !== undefined) out.outputProfile = normalizeProfileRef(content.outputProfile);

  if (level !== 'uncharacterized' && !out.outputProfile) throw new ValidationError(`level ${level} needs an output profile`);
  if ((level === 'L2' || level === 'L3') && (!out.curves || out.tacLimitPercent === undefined)) {
    throw new ValidationError(`level ${level} needs linearization curves and a TAC limit`);
  }
  if (level === 'L3' && !out.channelLimitsPercent) throw new ValidationError('level L3 needs per-channel limits');
  return out;
}

export interface RevisionInput {
  authorKind: RevisionAuthorKind;
  author: string;
  reason: string;
  content: ColorSetupContent;
  origin?: ColorSetupRevisionRecord['origin'];
  source?: ColorSetupRevisionRecord['source'];
}

/** Builds the next immutable revision of `setup`; does not persist anything. */
export function buildRevision(
  setup: Pick<ColorSetup, 'id' | 'headRevisionId' | 'revisionCount'>,
  input: RevisionInput,
  id: string,
  at: string,
): ColorSetupRevisionRecord {
  const content = normalizeContent(input.content);
  const revision: ColorSetupRevisionRecord = {
    id,
    colorSetupId: setup.id,
    seq: setup.revisionCount + 1,
    parentRevisionId: setup.headRevisionId,
    authorKind: input.authorKind,
    author: requireText(input.author, 'author'),
    createdAt: at,
    reason: requireText(input.reason, 'reason', 1000),
    contentHash: contentHash(content),
    content,
  };
  if (input.origin) revision.origin = { ...input.origin };
  if (input.source) revision.source = { ...input.source };
  return revision;
}

/** The setup with its head moved to `revision`. */
export function moveHead(setup: ColorSetup, revision: ColorSetupRevisionRecord): ColorSetup {
  return {
    ...setup,
    headRevisionId: revision.id,
    content: structuredClone(revision.content),
    revisionCount: revision.seq,
    userRevisionCount: setup.userRevisionCount + (revision.authorKind === 'user' ? 1 : 0),
    updatedAt: revision.createdAt,
  };
}
