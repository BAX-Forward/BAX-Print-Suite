import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { FastifyServerFactory } from 'fastify';
import { parseTlsConfig, type TlsMinVersion } from '@bax-print/core';

export const TLS_CERT_ENV = 'BPS_TLS_CERT';
export const TLS_KEY_ENV = 'BPS_TLS_KEY';
export const TLS_CA_ENV = 'BPS_TLS_CA';
export const TLS_MIN_VERSION_ENV = 'BPS_TLS_MIN_VERSION';

/** The `node:https` server options built from the Spec 029d TLS settings; file contents are read once at startup. */
export interface HttpsOptions {
  readonly cert: Buffer;
  readonly key: Buffer;
  /** Only used to verify client certificates; the server does not request them by default. */
  readonly ca?: Buffer;
  readonly minVersion: TlsMinVersion;
}

export type ReadTlsFile = (path: string) => Buffer;

/**
 * Spec 029d: reads BPS_TLS_CERT, BPS_TLS_KEY, BPS_TLS_CA and BPS_TLS_MIN_VERSION. Returns `undefined`
 * when neither the certificate nor the key is set, so the server stays on plain HTTP. Throws when
 * only one of them is set, when a setting is invalid, or when a file cannot be read. Relative paths
 * are resolved against the working directory.
 */
export function loadHttpsOptions(
  env: Readonly<Record<string, string | undefined>>,
  readFile: ReadTlsFile = (path) => readFileSync(path),
): HttpsOptions | undefined {
  const config = parseTlsConfig({
    certPath: env[TLS_CERT_ENV],
    keyPath: env[TLS_KEY_ENV],
    caPath: env[TLS_CA_ENV],
    minVersion: env[TLS_MIN_VERSION_ENV],
  });
  if (config === undefined) return undefined;
  return {
    cert: readTlsFile(readFile, config.certPath, TLS_CERT_ENV),
    key: readTlsFile(readFile, config.keyPath, TLS_KEY_ENV),
    ...(config.caPath === undefined ? {} : { ca: readTlsFile(readFile, config.caPath, TLS_CA_ENV) }),
    minVersion: config.minVersion,
  };
}

/** A Fastify server factory that serves over `node:https` with these options. A bad certificate or key throws here. */
export function httpsServerFactory(options: HttpsOptions): FastifyServerFactory {
  return (handler) => createServer({ ...options }, handler);
}

function readTlsFile(readFile: ReadTlsFile, path: string, name: string): Buffer {
  try {
    return readFile(path);
  } catch (error) {
    throw new Error(`${name} file ${path} could not be read`, { cause: error });
  }
}
