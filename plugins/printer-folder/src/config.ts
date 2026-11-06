import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { FolderOutputError, hasErrno } from './errors.js';

/** Finished-output formats this driver can hand to a folder. */
export const DOCUMENT_FORMATS = ['pdf', 'tiff'] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/** File extension written for each format. */
export const FORMAT_EXTENSIONS: Readonly<Record<DocumentFormat, string>> = Object.freeze({
  pdf: 'pdf',
  tiff: 'tiff',
});

export const DEFAULT_DEVICE_NAME = 'Folder output';
const MAX_DEVICE_NAME_LENGTH = 128;

/** Validated settings. Produced only by `parseFolderConfig`. */
export interface FolderOutputConfig {
  /** Absolute, existing, writable directory that receives output. */
  readonly outputDir: string;
  readonly acceptedFormats: readonly DocumentFormat[];
  readonly writeTicket: boolean;
  /** Free text shown in `describe`; never interpreted. */
  readonly deviceName: string;
}

export function isDocumentFormat(value: unknown): value is DocumentFormat {
  return DOCUMENT_FORMATS.some((format) => format === value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Problems with the directory itself, or an empty list when it exists and is writable. */
export function directoryProblems(dir: string): string[] {
  try {
    if (statSync(dir).isDirectory() === false) return [`outputDir is not a directory: ${dir}`];
  } catch (error) {
    return [hasErrno(error, 'ENOENT') ? `outputDir does not exist: ${dir}` : `outputDir cannot be read: ${dir}`];
  }
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    return [`outputDir is not writable: ${dir}`];
  }
  return [];
}

function checkOutputDir(value: unknown, problems: string[]): string {
  if (isNonEmptyString(value) === false) {
    problems.push('outputDir is required and must be a non-empty string');
    return '';
  }
  const raw = String(value);
  if (isAbsolute(raw) === false) {
    problems.push(`outputDir must be an absolute path, got "${raw}"`);
    return '';
  }
  const dir = resolve(raw);
  problems.push(...directoryProblems(dir));
  return dir;
}

function checkAcceptedFormats(value: unknown, problems: string[]): readonly DocumentFormat[] {
  if (value === undefined) return [...DOCUMENT_FORMATS];
  const entries: readonly unknown[] = Array.isArray(value) ? value : [];
  if (entries.length === 0) {
    problems.push(`acceptedFormats must be a non-empty array of: ${DOCUMENT_FORMATS.join(', ')}`);
    return [];
  }
  const formats: DocumentFormat[] = [];
  for (const entry of entries) {
    if (isDocumentFormat(entry)) {
      if (formats.includes(entry) === false) formats.push(entry);
    } else {
      problems.push(`acceptedFormats contains unsupported format ${JSON.stringify(entry)}`);
    }
  }
  return formats;
}

function checkWriteTicket(value: unknown, problems: string[]): boolean {
  if (value === undefined) return true;
  if (typeof value === 'boolean') return value;
  problems.push('writeTicket must be a boolean');
  return true;
}

function checkDeviceName(value: unknown, problems: string[]): string {
  if (value === undefined) return DEFAULT_DEVICE_NAME;
  if (isNonEmptyString(value) && value.trim().length <= MAX_DEVICE_NAME_LENGTH) return value.trim();
  problems.push(`deviceName must be a non-empty string of at most ${MAX_DEVICE_NAME_LENGTH} characters`);
  return DEFAULT_DEVICE_NAME;
}

/**
 * Validates raw `configure` settings. Reports every problem at once, as one CONFIG_INVALID error,
 * so an operator can fix the configuration in a single pass.
 */
export function parseFolderConfig(settings: Record<string, unknown>): FolderOutputConfig {
  const problems: string[] = [];
  const config: FolderOutputConfig = {
    outputDir: checkOutputDir(settings.outputDir, problems),
    acceptedFormats: checkAcceptedFormats(settings.acceptedFormats, problems),
    writeTicket: checkWriteTicket(settings.writeTicket, problems),
    deviceName: checkDeviceName(settings.deviceName, problems),
  };
  if (problems.length > 0) {
    throw new FolderOutputError('CONFIG_INVALID', `invalid folder output configuration: ${problems.join('; ')}`);
  }
  return config;
}
