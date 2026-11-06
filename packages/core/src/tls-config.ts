import { InvalidArgumentError } from './errors.js';

/** The `code` of every {@link InvalidArgumentError} thrown by {@link parseTlsConfig}. */
export const TLS_CONFIG_INVALID = 'tls_config_invalid';

/** The TLS protocol versions a server may require as its minimum. */
export const TLS_MIN_VERSIONS = ['TLSv1.2', 'TLSv1.3'] as const;
export type TlsMinVersion = (typeof TLS_MIN_VERSIONS)[number];
export const DEFAULT_TLS_MIN_VERSION: TlsMinVersion = 'TLSv1.2';

/** Raw, env-like TLS settings; an empty or whitespace-only value means "not configured". */
export interface TlsConfigInput {
  readonly certPath?: string | undefined;
  readonly keyPath?: string | undefined;
  readonly caPath?: string | undefined;
  readonly minVersion?: string | undefined;
}

/** Frozen TLS settings. Paths are trimmed but otherwise kept as given. */
export interface TlsConfig {
  readonly certPath: string;
  readonly keyPath: string;
  readonly caPath?: string;
  readonly minVersion: TlsMinVersion;
}

const DEL = 0x7f;
const FIRST_PRINTABLE = 0x20;

/**
 * Parses TLS settings, or returns `undefined` when neither a certificate nor a key is set (plain HTTP).
 * The certificate and key must be set together; a CA path or minimum version without them is rejected.
 * The minimum version defaults to TLSv1.2 and may only be TLSv1.2 or TLSv1.3.
 *
 * Paths are not confined to allowlisted roots: absolute and relative paths are both accepted, and a
 * relative path is resolved by whoever reads the file. The settings come from the operator who starts
 * the process, so they are trusted as much as the process itself. Paths with control characters are
 * rejected. Errors name the setting, never its value.
 */
export function parseTlsConfig(input: TlsConfigInput): TlsConfig | undefined {
  const certPath = parsePath(input.certPath, 'TLS certificate path');
  const keyPath = parsePath(input.keyPath, 'TLS key path');
  const caPath = parsePath(input.caPath, 'TLS CA path');
  const minVersionText = input.minVersion?.trim() ?? '';
  if (certPath === undefined && keyPath === undefined) {
    if (caPath === undefined && minVersionText === '') return undefined;
    throw invalid('TLS CA path and minimum version need a TLS certificate and key');
  }
  if (certPath === undefined || keyPath === undefined) {
    throw invalid('TLS certificate and key paths must be set together');
  }
  return Object.freeze({
    certPath,
    keyPath,
    ...(caPath === undefined ? {} : { caPath }),
    minVersion: parseMinVersion(minVersionText),
  });
}

function invalid(message: string): InvalidArgumentError {
  return new InvalidArgumentError(message, TLS_CONFIG_INVALID);
}

function parsePath(value: string | undefined, label: string): string | undefined {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return undefined;
  if ([...trimmed].some(isControlCharacter)) throw invalid(`${label} must not contain control characters`);
  return trimmed;
}

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < FIRST_PRINTABLE || code === DEL;
}

function parseMinVersion(text: string): TlsMinVersion {
  if (text === '') return DEFAULT_TLS_MIN_VERSION;
  const version = TLS_MIN_VERSIONS.find((candidate) => candidate === text);
  if (version === undefined) throw invalid(`TLS minimum version must be one of ${TLS_MIN_VERSIONS.join(', ')}`);
  return version;
}
