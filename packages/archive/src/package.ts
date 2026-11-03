import {
  ARTIFACT_ROLES,
  JOB_LIFECYCLES,
  isJobStatus,
  type ColorSetupRevision,
  type Job,
  type JobArtifact,
  type JobTicket,
  type ProfileRef,
  type SourceFile,
} from '@bax-print/core';
import { InvalidEventError, parseJsonl, toJsonl, type CloudEvent } from '@bax-print/events';
import { sanitizeKeySegment, sha256Hex } from '@bax-print/store';
import { PackageIntegrityError } from './errors.js';
import {
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  validateManifest,
  type ManifestMember,
  type MemberRole,
  type OmittedProfile,
  type PackageManifest,
} from './manifest.js';
import { readZip, writeZip, ZipFormatError } from './zip.js';

export const MANIFEST_PATH = 'manifest.json';
export const JOB_PATH = 'job.json';
export const TICKET_PATH = 'ticket.json';
export const COLOR_PATH = 'color/revisions.json';
export const HISTORY_PATH = 'history.jsonl';
export const DEFAULT_GENERATOR = 'bax-print-suite';

export interface PackInput {
  readonly job: Job;
  /** Bytes of each source file, in `job.sourceFiles` order. */
  readonly sources: readonly Uint8Array[];
  /** Bytes of each artifact, in `job.artifacts` order. */
  readonly artifacts: readonly Uint8Array[];
  readonly colorRevisions: readonly ColorSetupRevision[];
  /** Profile bytes by profile id; only redistributable profiles are packed. */
  readonly profiles: ReadonlyMap<string, Uint8Array>;
  readonly history: readonly CloudEvent[];
  readonly createdAt: Date;
  readonly generator?: string;
}

export interface PackResult {
  readonly bytes: Uint8Array;
  readonly manifest: PackageManifest;
  readonly warnings: readonly string[];
}

/** Contents of a verified package. `job.sourceFiles[].storageKey` are package member paths. */
export interface UnpackedPackage {
  readonly manifest: PackageManifest;
  readonly job: Job;
  readonly sources: readonly Uint8Array[];
  readonly artifacts: readonly Uint8Array[];
  readonly colorRevisions: readonly ColorSetupRevision[];
  readonly profiles: ReadonlyMap<string, Uint8Array>;
  readonly history: readonly CloudEvent[];
}

interface PendingMember {
  readonly path: string;
  readonly role: MemberRole;
  readonly data: Uint8Array;
}

export function sourceMemberPath(index: number, name: string): string {
  return `source/${index}-${sanitizeKeySegment(name)}`;
}

export function artifactMemberPath(artifact: JobArtifact, index: number): string {
  return `${artifact.role}/${index}-${sanitizeKeySegment(artifact.name)}`;
}

export function profileMemberPath(revisionId: string, ref: ProfileRef): string {
  return `profiles/${sanitizeKeySegment(revisionId)}/${sanitizeKeySegment(ref.id)}-${sanitizeKeySegment(ref.fileName)}`;
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function checkHash(data: Uint8Array, expected: string, what: string): void {
  if (sha256Hex(data) !== expected) {
    throw new PackageIntegrityError(`${what} does not match its recorded SHA-256`);
  }
}

/** Builds a `.bpsjob` package. Equal input (including `createdAt`) gives equal bytes. */
export function pack(input: PackInput): PackResult {
  const { job } = input;
  if (input.sources.length !== job.sourceFiles.length || input.artifacts.length !== job.artifacts.length) {
    throw new PackageIntegrityError('source and artifact bytes must match the job record one to one');
  }

  const files: PendingMember[] = [];
  const sourceFiles: SourceFile[] = job.sourceFiles.map((file, index) => {
    const data = input.sources[index];
    checkHash(data, file.sha256, `source ${file.name}`);
    const path = sourceMemberPath(index, file.name);
    files.push({ path, role: 'source', data });
    return { ...file, storageKey: path };
  });
  const artifacts: JobArtifact[] = job.artifacts.map((artifact, index) => {
    const data = input.artifacts[index];
    checkHash(data, artifact.sha256, `${artifact.role} artifact ${artifact.name}`);
    const path = artifactMemberPath(artifact, index);
    files.push({ path, role: artifact.role, data });
    return { ...artifact, storageKey: path };
  });

  const warnings: string[] = [];
  const omittedProfiles: OmittedProfile[] = [];
  for (const revision of input.colorRevisions) {
    for (const ref of revision.profiles) {
      if (!ref.redistributable) {
        omittedProfiles.push({ revisionId: revision.id, profileId: ref.id, reason: 'not-redistributable' });
        warnings.push(`profile ${ref.id} is not redistributable and was left out of the package`);
        continue;
      }
      const data = input.profiles.get(ref.id);
      if (!data) {
        omittedProfiles.push({ revisionId: revision.id, profileId: ref.id, reason: 'unavailable' });
        warnings.push(`profile ${ref.id} could not be read and was left out of the package`);
        continue;
      }
      checkHash(data, ref.sha256, `profile ${ref.id}`);
      files.push({ path: profileMemberPath(revision.id, ref), role: 'profile', data });
    }
  }

  const { ticket, ...jobRecord } = { ...job, sourceFiles, artifacts };
  const members: PendingMember[] = [
    { path: JOB_PATH, role: 'job', data: jsonBytes(jobRecord) },
    { path: TICKET_PATH, role: 'ticket', data: jsonBytes(ticket) },
    { path: COLOR_PATH, role: 'color', data: jsonBytes(input.colorRevisions) },
    { path: HISTORY_PATH, role: 'history', data: Buffer.from(toJsonl(input.history), 'utf8') },
    ...files,
  ];

  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    packageVersion: PACKAGE_VERSION,
    jobId: job.id,
    createdAt: input.createdAt.toISOString(),
    generator: input.generator ?? DEFAULT_GENERATOR,
    members: members.map(
      (member): ManifestMember => ({
        path: member.path,
        role: member.role,
        sha256: sha256Hex(member.data),
        size: member.data.byteLength,
      }),
    ),
    omittedProfiles,
  };

  const bytes = writeZip(
    [{ name: MANIFEST_PATH, data: jsonBytes(manifest) }, ...members.map((m) => ({ name: m.path, data: m.data }))],
    { modifiedAt: input.createdAt },
  );
  return { bytes, manifest, warnings };
}

function parseJson(data: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(Buffer.from(data).toString('utf8'));
  } catch (error) {
    throw new PackageIntegrityError(`${path} is not valid JSON`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileRecord(value: unknown): value is SourceFile {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.sha256 === 'string' &&
    typeof value.sizeBytes === 'number' &&
    typeof value.storageKey === 'string'
  );
}

/** Shape check for job.json, which may come from another installation. */
function parseJobRecord(value: unknown, ticket: unknown, manifest: PackageManifest): Job {
  if (!isRecord(value)) throw new PackageIntegrityError('job.json must be an object');
  const valid =
    value.id === manifest.jobId &&
    typeof value.name === 'string' &&
    isJobStatus(value.status) &&
    typeof value.priority === 'number' &&
    Array.isArray(value.sourceFiles) &&
    value.sourceFiles.every(isFileRecord) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every((a) => isFileRecord(a) && ARTIFACT_ROLES.includes((a as JobArtifact).role)) &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string') &&
    isRecord(value.metadata) &&
    Object.values(value.metadata).every((v) => typeof v === 'string') &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    JOB_LIFECYCLES.includes(value.lifecycle as Job['lifecycle']) &&
    typeof value.legalHold === 'boolean';
  if (!valid) throw new PackageIntegrityError('job.json does not describe a job of this package');
  if (!isRecord(ticket) || !isRecord(ticket.intent) || typeof ticket.intent.quantity !== 'number' || !isRecord(ticket.process)) {
    throw new PackageIntegrityError('ticket.json is not a job ticket');
  }
  return { ...(value as unknown as Job), ticket: ticket as unknown as JobTicket };
}

function parseRevisions(value: unknown): ColorSetupRevision[] {
  const valid =
    Array.isArray(value) &&
    value.every(
      (rev) =>
        isRecord(rev) &&
        typeof rev.id === 'string' &&
        typeof rev.deviceId === 'string' &&
        typeof rev.mediumId === 'string' &&
        Array.isArray(rev.profiles) &&
        rev.profiles.every((ref) => isRecord(ref) && typeof ref.id === 'string' && typeof ref.sha256 === 'string'),
    );
  if (!valid) throw new PackageIntegrityError('color/revisions.json is not a list of color setup revisions');
  return value as ColorSetupRevision[];
}

/** Reads a `.bpsjob`, verifying every member against the manifest. Throws `PackageIntegrityError`. */
export function unpack(bytes: Uint8Array): UnpackedPackage {
  let entries: Map<string, Uint8Array>;
  try {
    entries = readZip(bytes);
  } catch (error) {
    if (error instanceof ZipFormatError) {
      throw new PackageIntegrityError(`package is not a valid ZIP: ${error.message}`, { cause: error });
    }
    throw error;
  }

  const manifestData = entries.get(MANIFEST_PATH);
  if (!manifestData) throw new PackageIntegrityError('package has no manifest.json');
  const manifest = validateManifest(parseJson(manifestData, MANIFEST_PATH));

  const listed = new Map(manifest.members.map((member) => [member.path, member]));
  for (const name of entries.keys()) {
    if (name !== MANIFEST_PATH && !listed.has(name)) {
      throw new PackageIntegrityError(`member ${name} is not listed in the manifest`);
    }
  }
  for (const member of manifest.members) {
    const data = entries.get(member.path);
    if (!data) throw new PackageIntegrityError(`member ${member.path} is missing`);
    if (data.byteLength !== member.size || sha256Hex(data) !== member.sha256) {
      throw new PackageIntegrityError(`member ${member.path} does not match its SHA-256 in the manifest`);
    }
  }

  const member = (path: string, roles: readonly MemberRole[]): Uint8Array => {
    const listing = listed.get(path);
    const data = entries.get(path);
    if (!listing || !data || !roles.includes(listing.role)) {
      throw new PackageIntegrityError(`required member ${path} is missing`);
    }
    return data;
  };

  const job = parseJobRecord(
    parseJson(member(JOB_PATH, ['job']), JOB_PATH),
    parseJson(member(TICKET_PATH, ['ticket']), TICKET_PATH),
    manifest,
  );
  const sources = job.sourceFiles.map((file) => {
    const data = member(file.storageKey, ['source']);
    checkHash(data, file.sha256, `source ${file.name}`);
    return data;
  });
  const artifacts = job.artifacts.map((artifact) => {
    const data = member(artifact.storageKey, [artifact.role]);
    checkHash(data, artifact.sha256, `${artifact.role} artifact ${artifact.name}`);
    return data;
  });

  const colorRevisions = parseRevisions(parseJson(member(COLOR_PATH, ['color']), COLOR_PATH));
  const omitted = new Set(manifest.omittedProfiles.map((o) => `${o.revisionId}\u0000${o.profileId}`));
  const profiles = new Map<string, Uint8Array>();
  for (const revision of colorRevisions) {
    for (const ref of revision.profiles) {
      if (omitted.has(`${revision.id}\u0000${ref.id}`)) continue;
      const data = member(profileMemberPath(revision.id, ref), ['profile']);
      checkHash(data, ref.sha256, `profile ${ref.id}`);
      profiles.set(ref.id, data);
    }
  }

  let history: CloudEvent[];
  try {
    history = parseJsonl(Buffer.from(member(HISTORY_PATH, ['history'])).toString('utf8'));
  } catch (error) {
    if (error instanceof InvalidEventError) {
      throw new PackageIntegrityError(`history.jsonl is invalid: ${error.message}`, { cause: error });
    }
    throw error;
  }

  return { manifest, job, sources, artifacts, colorRevisions, profiles, history };
}
