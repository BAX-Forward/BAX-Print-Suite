import { assertSafeEntryName, ZipFormatError } from './zip.js';
import { PackageIntegrityError } from './errors.js';

/** Mirrors `schema/manifest.schema.json`; keep both in sync. */

export const PACKAGE_FORMAT = 'bpsjob';
export const PACKAGE_VERSION = 1;

export const MEMBER_ROLES = ['job', 'ticket', 'color', 'history', 'source', 'profile', 'layout', 'cut', 'preview', 'normalized'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const OMISSION_REASONS = ['not-redistributable', 'unavailable'] as const;
export type OmissionReason = (typeof OMISSION_REASONS)[number];

export interface ManifestMember {
  readonly path: string;
  readonly role: MemberRole;
  readonly sha256: string;
  readonly size: number;
}

export interface OmittedProfile {
  readonly revisionId: string;
  readonly profileId: string;
  readonly reason: OmissionReason;
}

export interface PackageManifest {
  readonly format: typeof PACKAGE_FORMAT;
  readonly packageVersion: typeof PACKAGE_VERSION;
  readonly jobId: string;
  readonly createdAt: string;
  readonly generator: string;
  readonly members: readonly ManifestMember[];
  readonly omittedProfiles: readonly OmittedProfile[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function invalid(message: string): never {
  throw new PackageIntegrityError(`invalid manifest: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') invalid(`${field} must be a non-empty string`);
  return value;
}

function parseMember(value: unknown, index: number): ManifestMember {
  if (!isRecord(value)) invalid(`members[${index}] must be an object`);
  const path = nonEmptyString(value.path, `members[${index}].path`);
  try {
    assertSafeEntryName(path);
  } catch (error) {
    if (error instanceof ZipFormatError) invalid(`members[${index}].path is unsafe`);
    throw error;
  }
  const { role, sha256, size } = value;
  if (!MEMBER_ROLES.includes(role as MemberRole)) invalid(`members[${index}].role is unknown`);
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    invalid(`members[${index}].sha256 must be 64 lowercase hex digits`);
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    invalid(`members[${index}].size must be a non-negative integer`);
  }
  return { path, role: role as MemberRole, sha256, size };
}

function parseOmitted(value: unknown, index: number): OmittedProfile {
  if (!isRecord(value)) invalid(`omittedProfiles[${index}] must be an object`);
  if (!OMISSION_REASONS.includes(value.reason as OmissionReason)) {
    invalid(`omittedProfiles[${index}].reason is unknown`);
  }
  return {
    revisionId: nonEmptyString(value.revisionId, `omittedProfiles[${index}].revisionId`),
    profileId: nonEmptyString(value.profileId, `omittedProfiles[${index}].profileId`),
    reason: value.reason as OmissionReason,
  };
}

export function validateManifest(value: unknown): PackageManifest {
  if (!isRecord(value)) invalid('not an object');
  if (value.format !== PACKAGE_FORMAT) invalid(`format must be "${PACKAGE_FORMAT}"`);
  if (value.packageVersion !== PACKAGE_VERSION) {
    invalid(`unsupported packageVersion ${String(value.packageVersion)}; this build reads version ${PACKAGE_VERSION}`);
  }
  const createdAt = nonEmptyString(value.createdAt, 'createdAt');
  if (Number.isNaN(Date.parse(createdAt))) invalid('createdAt must be a date-time');
  const { generator, members: rawMembers, omittedProfiles } = value;
  if (typeof generator !== 'string') invalid('generator must be a string');
  if (!Array.isArray(rawMembers)) invalid('members must be an array');
  if (!Array.isArray(omittedProfiles)) invalid('omittedProfiles must be an array');

  const members = rawMembers.map(parseMember);
  const paths = new Set<string>();
  for (const member of members) {
    if (paths.has(member.path)) invalid(`duplicate member ${member.path}`);
    paths.add(member.path);
  }

  return {
    format: PACKAGE_FORMAT,
    packageVersion: PACKAGE_VERSION,
    jobId: nonEmptyString(value.jobId, 'jobId'),
    createdAt,
    generator,
    members,
    omittedProfiles: omittedProfiles.map(parseOmitted),
  };
}
