import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get, Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket, type SecureVersion } from 'node:tls';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import { InvalidArgumentError, TLS_CONFIG_INVALID } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { loadHttpsOptions, TLS_CA_ENV, TLS_CERT_ENV, TLS_KEY_ENV, TLS_MIN_VERSION_ENV, type HttpsOptions } from '../src/tls.js';
import { selfSignedCert, type SelfSignedCert } from './self-signed-cert.js';

interface TlsResponse {
  readonly status: number;
  readonly body: string;
  readonly fingerprint256: string;
  readonly protocol: string | null;
}

function archiveService(): ArchiveService {
  const outbox = new MemoryOutbox();
  return new ArchiveService({
    jobs: new MemoryJobRepository(),
    index: new MemoryArchiveIndex(),
    blobs: new MemoryStorage(),
    archive: new MemoryStorage(),
    bus: new EventBus(outbox),
    outbox,
    colorSetups: new StaticColorSetupResolver(),
  });
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected function to throw');
}

/** One GET over TLS without pooling. The test certificate is not trusted, so it is checked by fingerprint instead. */
function httpsGet(port: number, path: string, maxVersion: SecureVersion = 'TLSv1.3'): Promise<TlsResponse> {
  return new Promise((resolvePromise, reject) => {
    const request = get({ host: '127.0.0.1', port, path, agent: false, rejectUnauthorized: false, maxVersion }, (response) => {
      const { socket } = response;
      if (socket instanceof TLSSocket) {
        const fingerprint256 = socket.getPeerCertificate().fingerprint256;
        const protocol = socket.getProtocol();
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), fingerprint256, protocol }),
        );
        return;
      }
      response.resume();
      reject(new Error('the response did not arrive over TLS'));
    });
    request.on('error', reject);
  });
}

function listeningPort(app: FastifyInstance): number {
  const address = app.server.address();
  if (typeof address === 'object' && address !== null) return address.port;
  throw new Error('the server is not listening on a TCP port');
}

let generated: SelfSignedCert;
let app: FastifyInstance | undefined;
let dir: string | undefined;

beforeAll(() => {
  generated = selfSignedCert();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (dir === undefined) return;
  await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

function httpsOptions(overrides: Partial<HttpsOptions> = {}): HttpsOptions {
  return { cert: Buffer.from(generated.cert), key: Buffer.from(generated.key), minVersion: 'TLSv1.2', ...overrides };
}

describe('loadHttpsOptions', () => {
  it('returns undefined without BPS_TLS_CERT and BPS_TLS_KEY, so the server stays on HTTP', () => {
    const readFile = (): Buffer => {
      throw new Error('no file should be read');
    };
    expect(loadHttpsOptions({}, readFile)).toBeUndefined();
    expect(loadHttpsOptions({ [TLS_CERT_ENV]: '', [TLS_KEY_ENV]: ' ' }, readFile)).toBeUndefined();
  });

  it.each([TLS_CERT_ENV, TLS_KEY_ENV])('fails startup when only %s is set', (name) => {
    const error = captureError(() => loadHttpsOptions({ [name]: '/tmp/tls.pem' }));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error).toMatchObject({ code: TLS_CONFIG_INVALID });
  });

  it('rejects a minimum version other than TLSv1.2 or TLSv1.3', () => {
    const error = captureError(() =>
      loadHttpsOptions({ [TLS_CERT_ENV]: 'c', [TLS_KEY_ENV]: 'k', [TLS_MIN_VERSION_ENV]: 'TLSv1.1' }, () => Buffer.alloc(0)),
    );
    expect(error).toMatchObject({ code: TLS_CONFIG_INVALID });
  });

  it('reads the certificate, key and CA files at startup', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'bps-tls-'));
    dir = tmp;
    const certPath = join(tmp, 'server.crt');
    const keyPath = join(tmp, 'server.key');
    const caPath = join(tmp, 'ca.crt');
    await Promise.all([writeFile(certPath, generated.cert), writeFile(keyPath, generated.key), writeFile(caPath, generated.cert)]);

    const options = loadHttpsOptions({
      [TLS_CERT_ENV]: certPath,
      [TLS_KEY_ENV]: keyPath,
      [TLS_CA_ENV]: caPath,
      [TLS_MIN_VERSION_ENV]: 'TLSv1.3',
    });

    expect(options?.cert.toString('utf8')).toBe(generated.cert);
    expect(options?.key.toString('utf8')).toBe(generated.key);
    expect(options?.ca?.toString('utf8')).toBe(generated.cert);
    expect(options?.minVersion).toBe('TLSv1.3');
  });

  it('fails startup when a file is missing, naming the variable', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'bps-tls-'));
    dir = tmp;
    const certPath = join(tmp, 'server.crt');
    await writeFile(certPath, generated.cert);

    const error = captureError(() => loadHttpsOptions({ [TLS_CERT_ENV]: certPath, [TLS_KEY_ENV]: join(tmp, 'missing.key') }));

    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('message', expect.stringContaining(`${TLS_KEY_ENV} file`));
    expect(error).toHaveProperty('cause.code', 'ENOENT');
  });
});

describe('buildServer with https', () => {
  it('answers injected requests', async () => {
    app = buildServer({ archive: archiveService(), https: httpsOptions() });

    const response = await app.inject({ method: 'GET', url: '/trash' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  it('serves HTTPS with the configured certificate on a real port', async () => {
    app = buildServer({ archive: archiveService(), https: httpsOptions() });
    await app.listen({ host: '127.0.0.1', port: 0 });

    const response = await httpsGet(listeningPort(app), '/trash');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ items: [] });
    expect(response.fingerprint256).toBe(new X509Certificate(generated.cert).fingerprint256);
    expect(['TLSv1.2', 'TLSv1.3']).toContain(response.protocol);
  });

  it('refuses a client limited to TLSv1.2 when the minimum is TLSv1.3', async () => {
    app = buildServer({ archive: archiveService(), https: httpsOptions({ minVersion: 'TLSv1.3' }) });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = listeningPort(app);

    await expect(httpsGet(port, '/trash', 'TLSv1.2')).rejects.toThrow();
    expect((await httpsGet(port, '/trash')).protocol).toBe('TLSv1.3');
  });

  it('fails at startup on a key that is not PEM', () => {
    expect(() => buildServer({ archive: archiveService(), https: httpsOptions({ key: Buffer.from('not a key') }) })).toThrow();
  });

  it('uses an HTTPS server only when https options are given', () => {
    app = buildServer({ archive: archiveService(), https: httpsOptions() });
    expect(app.server).toBeInstanceOf(HttpsServer);
  });

  it('stays on plain HTTP without https options', () => {
    app = buildServer({ archive: archiveService() });
    expect(app.server).not.toBeInstanceOf(HttpsServer);
  });
});
