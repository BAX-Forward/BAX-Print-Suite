import {
  type ColorDefaults,
  type ColorSetupContent,
  type DeviceRef,
  type Medium,
  type MediumKind,
  type OutputMode,
  type StoredProfileRef,
  ValidationError,
  canonicalJson,
} from '@bax-print/core';
import { type OutputModeReport, checkOutputModeReport } from '@bax-print/plugin-sdk';
import { type UnzipFileInfo, unzipSync, zipSync } from 'fflate';
import { curvesFromText, curvesToText } from './curves-text.js';
import type { ColorSetupPublishedEvent } from './events.js';
import { fromUtf8, sha256Hex, utf8 } from './hash.js';
import { type MediaLibrary, type MediumInput, mediumFields } from './library.js';
import { normalizeContent } from './revisions.js';
import { requireText } from './validate.js';

/** Spec 005 FR8: our own exchange format, a zip with a manifest of SHA-256 digests. */
export const BPSMEDIA_FORMAT = 'bpsmedia';
export const BPSMEDIA_VERSION = 1;
export const BPSMEDIA_EXTENSION = '.bpsmedia';
export const BPSMEDIA_MEDIA_TYPE = 'application/vnd.bax-print.bpsmedia+zip';
export const MEDIUM_SCHEMA_VERSION = 1;

const MANIFEST = 'manifest.json';
const MEDIUM = 'medium.json';
const MAX_MEMBERS = 1000;
const MAX_MEMBER_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Zip timestamps are fixed so the same library state always exports the same bytes. */
const ZIP_MTIME = new Date('2000-01-01T00:00:00Z');
const MEMBER_PATH = /^(medium\.json|curves\/mode-\d+\.txt|profiles\/[0-9a-f]{64}\.(icc|bin))$/;

export interface ExchangeColorSetup {
  /** Setup content without curves; curves live in `curvesFile` as CGATS-like text. */
  content: Omit<ColorSetupContent, 'curves'>;
  curvesFile?: string;
}

export interface ExchangeMode {
  deviceProfile: string;
  modeKey: string;
  name: string;
  resolutionDpi: { x: number; y: number };
  passes: number;
  inkSet: string[];
  direction: OutputMode['direction'];
  params: Record<string, unknown>;
  colorDefaults?: ColorDefaults;
  hidden: boolean;
  colorSetup: ExchangeColorSetup;
}

/** `medium.json`: no ids and no timestamps, so an export of an import is hash-equal. */
export interface ExchangeMedium {
  schemaVersion: typeof MEDIUM_SCHEMA_VERSION;
  medium: {
    name: string;
    kind: MediumKind;
    widthsMm: number[];
    thicknessUm?: number;
    form: Medium['form'];
    sides: Medium['sides'];
    deviceRef?: DeviceRef;
  };
  modes: ExchangeMode[];
}

export interface ManifestMember {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface OmittedProfile {
  sha256: string;
  description: string;
  license: string;
  reason: 'not-redistributable' | 'not-in-store';
}

export interface BpsMediaManifest {
  format: typeof BPSMEDIA_FORMAT;
  version: typeof BPSMEDIA_VERSION;
  generator: string;
  members: ManifestMember[];
  omittedProfiles: OmittedProfile[];
}

export interface ExportResult {
  bytes: Uint8Array;
  manifest: BpsMediaManifest;
  /** Canonical `medium.json` text, as stored in the archive. */
  mediumJson: string;
  warnings: string[];
}

export interface MissingProfileRef {
  modeKey: string;
  deviceProfile: string;
  sha256: string;
  description: string;
}

export interface ImportResult {
  medium: Medium;
  modes: OutputMode[];
  mediumJson: string;
  /** Profile refs kept in the imported setups whose bytes are neither in the archive nor in the store. */
  missingProfiles: MissingProfileRef[];
  warnings: string[];
}

function profilePath(ref: StoredProfileRef): string {
  return `profiles/${ref.sha256}.${ref.format === 'icc' ? 'icc' : 'bin'}`;
}

function sortedModes(modes: readonly OutputMode[]): OutputMode[] {
  return [...modes].sort((a, b) =>
    a.deviceProfile === b.deviceProfile ? (a.modeKey < b.modeKey ? -1 : a.modeKey > b.modeKey ? 1 : 0) : a.deviceProfile < b.deviceProfile ? -1 : 1,
  );
}

/**
 * Exports a medium with every mode and its color setup head. Non-redistributable profiles are
 * omitted (the ref stays in `medium.json`) and reported as warnings.
 */
export function exportMedium(library: MediaLibrary, mediumId: string): ExportResult {
  const repo = library.ctx.repo;
  const medium = library.getMedium(mediumId);
  const files: Record<string, Uint8Array> = {};
  const omitted = new Map<string, OmittedProfile>();
  const warnings: string[] = [];

  const modes = sortedModes(repo.listOutputModes(medium.id)).map((mode, index): ExchangeMode => {
    const setup = library.getColorSetupForMode(mode.id);
    const { curves, ...rest } = structuredClone(setup.content);
    const colorSetup: ExchangeColorSetup = { content: rest };
    if (curves) {
      colorSetup.curvesFile = `curves/mode-${index + 1}.txt`;
      files[colorSetup.curvesFile] = utf8(curvesToText(curves, mode.inkSet));
    }
    const ref = rest.outputProfile;
    if (ref && !(profilePath(ref) in files) && !omitted.has(ref.sha256)) {
      const bytes = ref.provenance.redistributable ? repo.getProfileBytes(ref.sha256) : undefined;
      if (bytes) {
        files[profilePath(ref)] = bytes;
      } else {
        const reason = ref.provenance.redistributable ? 'not-in-store' : 'not-redistributable';
        omitted.set(ref.sha256, { sha256: ref.sha256, description: ref.description, license: ref.provenance.license, reason });
        warnings.push(
          reason === 'not-redistributable'
            ? `profile "${ref.description}" (${ref.sha256}) is not redistributable and was omitted`
            : `profile "${ref.description}" (${ref.sha256}) is missing from the store and was omitted`,
        );
      }
    }
    const out: ExchangeMode = {
      deviceProfile: mode.deviceProfile,
      modeKey: mode.modeKey,
      name: mode.name,
      resolutionDpi: { ...mode.resolutionDpi },
      passes: mode.passes,
      inkSet: [...mode.inkSet],
      direction: mode.direction,
      params: structuredClone(mode.params),
      hidden: mode.hidden,
      colorSetup,
    };
    if (mode.colorDefaults) out.colorDefaults = structuredClone(mode.colorDefaults);
    return out;
  });

  const exchange: ExchangeMedium = {
    schemaVersion: MEDIUM_SCHEMA_VERSION,
    medium: {
      name: medium.name,
      kind: { ...medium.kind },
      widthsMm: [...medium.widthsMm],
      form: medium.form,
      sides: medium.sides,
    },
    modes,
  };
  if (medium.thicknessUm !== undefined) exchange.medium.thicknessUm = medium.thicknessUm;
  if (medium.deviceRef) exchange.medium.deviceRef = { ...medium.deviceRef };
  const mediumJson = canonicalJson(exchange);
  files[MEDIUM] = utf8(mediumJson);

  const manifest: BpsMediaManifest = {
    format: BPSMEDIA_FORMAT,
    version: BPSMEDIA_VERSION,
    generator: 'BAX Print Suite',
    members: Object.keys(files)
      .sort()
      .map((path) => ({ path, sha256: sha256Hex(files[path]!), sizeBytes: files[path]!.length })),
    omittedProfiles: [...omitted.values()].sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1)),
  };
  const entries: Record<string, Uint8Array> = { [MANIFEST]: utf8(canonicalJson(manifest)) };
  for (const member of manifest.members) entries[member.path] = files[member.path]!;
  const bytes = zipSync(entries, { level: 6, mtime: ZIP_MTIME });
  return { bytes, manifest, mediumJson, warnings };
}

function readArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new ValidationError('the archive is empty');
  let members = 0;
  let total = 0;
  const filter = (file: UnzipFileInfo): boolean => {
    members += 1;
    total += file.originalSize;
    if (members > MAX_MEMBERS) throw new ValidationError(`the archive has more than ${MAX_MEMBERS} members`);
    if (file.originalSize > MAX_MEMBER_BYTES || total > MAX_TOTAL_BYTES) throw new ValidationError('the archive is too large');
    return !file.name.endsWith('/');
  };
  try {
    return unzipSync(bytes, { filter });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`not a readable ${BPSMEDIA_EXTENSION} archive: ${(error as Error).message}`);
  }
}

function parseJsonMember(bytes: Uint8Array | undefined, path: string): unknown {
  if (!bytes) throw new ValidationError(`the archive has no ${path}`);
  try {
    return JSON.parse(fromUtf8(bytes));
  } catch {
    throw new ValidationError(`${path} is not valid UTF-8 JSON`);
  }
}

/** Checks the manifest against the archive: same member set, matching sizes and digests. */
function verifiedMembers(entries: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const manifest = parseJsonMember(entries[MANIFEST], MANIFEST) as Partial<BpsMediaManifest> | null;
  if (!manifest || manifest.format !== BPSMEDIA_FORMAT) throw new ValidationError(`${MANIFEST} is not a ${BPSMEDIA_FORMAT} manifest`);
  if (manifest.version !== BPSMEDIA_VERSION) throw new ValidationError(`unsupported ${BPSMEDIA_FORMAT} version ${String(manifest.version)}`);
  if (!Array.isArray(manifest.members)) throw new ValidationError(`${MANIFEST} has no member list`);
  const listed = new Set<string>();
  const members: Record<string, Uint8Array> = {};
  for (const member of manifest.members) {
    const path = member?.path;
    if (typeof path !== 'string' || !MEMBER_PATH.test(path)) throw new ValidationError(`unexpected member path ${String(path)}`);
    if (listed.has(path)) throw new ValidationError(`member ${path} is listed twice`);
    listed.add(path);
    const data = entries[path];
    if (!data) throw new ValidationError(`member ${path} is listed but missing`);
    if (data.length !== member.sizeBytes || sha256Hex(data) !== member.sha256) {
      throw new ValidationError(`member ${path} does not match its manifest digest`);
    }
    members[path] = data;
  }
  for (const path of Object.keys(entries)) {
    if (path !== MANIFEST && !listed.has(path)) throw new ValidationError(`member ${path} is not in the manifest`);
  }
  return members;
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function parseExchangeMode(value: unknown, index: number): ExchangeMode {
  const where = `modes[${index}]`;
  const raw = asObject(value, where);
  const report = raw as unknown as OutputModeReport;
  const failures = checkOutputModeReport(report, where);
  if (failures.length > 0) throw new ValidationError(failures.join('; '));
  if (typeof raw.hidden !== 'boolean') throw new ValidationError(`${where}.hidden must be a boolean`);
  const setup = asObject(raw.colorSetup, `${where}.colorSetup`);
  const content = asObject(setup.content, `${where}.colorSetup.content`) as unknown as ExchangeColorSetup['content'];
  if ('curves' in content) throw new ValidationError(`${where}.colorSetup.content must not inline curves`);
  const colorSetup: ExchangeColorSetup = { content };
  if (setup.curvesFile !== undefined) colorSetup.curvesFile = requireText(setup.curvesFile, `${where}.colorSetup.curvesFile`);
  const mode: ExchangeMode = {
    deviceProfile: requireText(raw.deviceProfile, `${where}.deviceProfile`),
    modeKey: report.modeKey,
    name: report.name,
    resolutionDpi: { x: report.resolutionDpi.x, y: report.resolutionDpi.y },
    passes: report.passes,
    inkSet: [...report.inkSet],
    direction: report.direction,
    params: structuredClone(asObject(raw.params ?? {}, `${where}.params`)),
    hidden: raw.hidden,
    colorSetup,
  };
  if (raw.colorDefaults !== undefined) mode.colorDefaults = structuredClone(asObject(raw.colorDefaults, `${where}.colorDefaults`)) as ColorDefaults;
  return mode;
}

/** Validates a parsed `medium.json` (the JSON Schema in `packages/media/schema` documents the same shape). */
export function parseExchangeMedium(value: unknown): ExchangeMedium {
  const raw = asObject(value, MEDIUM);
  if (raw.schemaVersion !== MEDIUM_SCHEMA_VERSION) throw new ValidationError(`unsupported medium.json schemaVersion ${String(raw.schemaVersion)}`);
  const medium = asObject(raw.medium, 'medium');
  const fields = mediumFields(medium as unknown as MediumInput);
  const out: ExchangeMedium = { schemaVersion: MEDIUM_SCHEMA_VERSION, medium: { ...fields }, modes: [] };
  if (medium.deviceRef !== undefined) {
    const ref = asObject(medium.deviceRef, 'medium.deviceRef');
    out.medium.deviceRef = {
      deviceProfile: requireText(ref.deviceProfile, 'medium.deviceRef.deviceProfile'),
      mediumKey: requireText(ref.mediumKey, 'medium.deviceRef.mediumKey'),
    };
  }
  if (!Array.isArray(raw.modes)) throw new ValidationError('modes must be an array');
  const keys = new Set<string>();
  out.modes = raw.modes.map((mode, i) => {
    const parsed = parseExchangeMode(mode, i);
    const key = `${parsed.deviceProfile}\u0000${parsed.modeKey}`;
    if (keys.has(key)) throw new ValidationError(`mode ${parsed.modeKey} appears twice`);
    keys.add(key);
    return parsed;
  });
  return out;
}

/**
 * Imports a `.bpsmedia` archive as a new medium. Each setup gets a fresh revision chain whose
 * first revision records the import. Profiles absent from both the archive and the store keep
 * their content-addressed ref and are reported in `missingProfiles`.
 */
export function importMedium(
  library: MediaLibrary,
  bytes: Uint8Array,
  options: { author: string; sourceName?: string },
): ImportResult {
  const author = requireText(options.author, 'author');
  const sourceName = options.sourceName === undefined ? BPSMEDIA_FORMAT : requireText(options.sourceName, 'sourceName');
  const members = verifiedMembers(readArchive(bytes));
  const exchange = parseExchangeMedium(parseJsonMember(members[MEDIUM], MEDIUM));
  const ctx = library.ctx;
  const warnings: string[] = [];
  const missing: MissingProfileRef[] = [];

  const { medium, modes, events } = ctx.repo.transaction(() => {
    const at = ctx.now();
    const { deviceRef, ...fields } = exchange.medium;
    const medium: Medium = {
      id: ctx.newId(),
      ...fields,
      archived: false,
      source: 'import',
      userOverrides: [],
      createdAt: at,
      updatedAt: at,
    };
    if (deviceRef) {
      if (ctx.repo.findMediumByDeviceRef(deviceRef.deviceProfile, deviceRef.mediumKey)) {
        warnings.push(`a medium for device medium ${deviceRef.mediumKey} already exists; the import is not linked to the device`);
      } else {
        medium.deviceRef = deviceRef;
      }
    }
    ctx.repo.insertMedium(medium);

    const modes: OutputMode[] = [];
    const events: ColorSetupPublishedEvent[] = [];
    for (const item of exchange.modes) {
      const { colorSetup, colorDefaults, ...modeFields } = item;
      const mode: OutputMode = { id: ctx.newId(), mediumId: medium.id, ...modeFields, createdAt: at, updatedAt: at };
      if (colorDefaults) mode.colorDefaults = colorDefaults;
      ctx.repo.insertOutputMode(mode);
      modes.push(mode);

      const content: ColorSetupContent = { ...colorSetup.content } as ColorSetupContent;
      if (colorSetup.curvesFile !== undefined) {
        const text = members[colorSetup.curvesFile];
        if (!text) throw new ValidationError(`curves file ${colorSetup.curvesFile} is missing`);
        content.curves = curvesFromText(fromUtf8(text));
      }
      const ref = content.outputProfile;
      if (ref) {
        const profileBytes = typeof ref.sha256 === 'string' ? members[profilePath(ref)] : undefined;
        if (profileBytes) {
          const stored = library.addProfile(profileBytes, {
            description: ref.description,
            format: ref.format,
            mediaType: ref.mediaType,
            colorants: ref.colorants,
            provenance: ref.provenance,
          });
          if (stored.sha256 !== ref.sha256) throw new ValidationError(`profile ${ref.sha256} does not match its bytes`);
        } else if (!ctx.repo.getProfile(ref.sha256)) {
          missing.push({ modeKey: mode.modeKey, deviceProfile: mode.deviceProfile, sha256: ref.sha256, description: ref.description });
        }
      }
      const { revision } = library.createColorSetup(mode, {
        authorKind: 'user',
        author,
        reason: `imported from ${sourceName}`,
        content: normalizeContent(content),
        source: { importedFrom: sourceName },
      });
      events.push(library.publishedEvent(revision));
    }
    return { medium, modes, events };
  });
  events.forEach(ctx.emit);
  for (const ref of missing) warnings.push(`profile "${ref.description}" (${ref.sha256}) for mode ${ref.modeKey} is not available`);
  return { medium, modes, mediumJson: canonicalJson(exchange), missingProfiles: missing, warnings };
}
