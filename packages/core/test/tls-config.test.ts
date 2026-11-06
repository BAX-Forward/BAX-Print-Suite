import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TLS_MIN_VERSION,
  InvalidArgumentError,
  parseTlsConfig,
  TLS_CONFIG_INVALID,
  type TlsConfigInput,
} from '../src/index.js';

const CERT = '/etc/bps/tls/server.crt';
const KEY = '/etc/bps/tls/server.key';

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected function to throw');
}

function expectInvalid(input: TlsConfigInput, message: RegExp): void {
  const error = captureError(() => parseTlsConfig(input));
  expect(error).toBeInstanceOf(InvalidArgumentError);
  expect(error).toMatchObject({ code: TLS_CONFIG_INVALID });
  expect(error).toHaveProperty('message', expect.stringMatching(message));
}

describe('parseTlsConfig', () => {
  it('returns undefined when neither certificate nor key is set', () => {
    expect(parseTlsConfig({})).toBeUndefined();
    expect(parseTlsConfig({ certPath: '', keyPath: '  ', caPath: '', minVersion: ' ' })).toBeUndefined();
  });

  it('returns a frozen config with the default minimum version', () => {
    const config = parseTlsConfig({ certPath: CERT, keyPath: KEY });
    expect(config).toEqual({ certPath: CERT, keyPath: KEY, minVersion: 'TLSv1.2' });
    expect(DEFAULT_TLS_MIN_VERSION).toBe('TLSv1.2');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('trims paths and keeps relative paths as given', () => {
    const config = parseTlsConfig({ certPath: ' tls/server.crt ', keyPath: './tls/server.key\n' });
    expect(config).toEqual({ certPath: 'tls/server.crt', keyPath: './tls/server.key', minVersion: 'TLSv1.2' });
  });

  it('accepts absolute paths anywhere, since no roots are allowlisted', () => {
    const config = parseTlsConfig({ certPath: '/srv/../etc/cert.pem', keyPath: 'C:\\certs\\key.pem' });
    expect(config).toMatchObject({ certPath: '/srv/../etc/cert.pem', keyPath: 'C:\\certs\\key.pem' });
  });

  it('includes the CA path when set', () => {
    expect(parseTlsConfig({ certPath: CERT, keyPath: KEY, caPath: '/etc/bps/tls/ca.pem' })).toEqual({
      certPath: CERT,
      keyPath: KEY,
      caPath: '/etc/bps/tls/ca.pem',
      minVersion: 'TLSv1.2',
    });
  });

  it.each(['TLSv1.2', 'TLSv1.3', ' TLSv1.3 '])('accepts minimum version %j', (minVersion) => {
    expect(parseTlsConfig({ certPath: CERT, keyPath: KEY, minVersion })?.minVersion).toBe(minVersion.trim());
  });

  it.each(['TLSv1', 'TLSv1.1', 'tlsv1.2', '1.2', 'TLSv1.4', 'SSLv3'])('rejects minimum version %j', (minVersion) => {
    expectInvalid({ certPath: CERT, keyPath: KEY, minVersion }, /minimum version must be one of TLSv1\.2, TLSv1\.3/);
  });

  it('rejects a certificate without a key', () => {
    expectInvalid({ certPath: CERT }, /certificate and key paths must be set together/);
    expectInvalid({ certPath: CERT, keyPath: ' ' }, /certificate and key paths must be set together/);
  });

  it('rejects a key without a certificate', () => {
    expectInvalid({ keyPath: KEY }, /certificate and key paths must be set together/);
  });

  it('rejects a CA path or minimum version without a certificate and key', () => {
    expectInvalid({ caPath: '/etc/bps/tls/ca.pem' }, /need a TLS certificate and key/);
    expectInvalid({ minVersion: 'TLSv1.3' }, /need a TLS certificate and key/);
  });

  it('rejects paths with control characters without echoing them', () => {
    const error = captureError(() => parseTlsConfig({ certPath: '/tmp/a\u0000b', keyPath: KEY }));
    expect(error).toMatchObject({ code: TLS_CONFIG_INVALID, message: 'TLS certificate path must not contain control characters' });
    expectInvalid({ certPath: CERT, keyPath: '/tmp/a\u007fb' }, /TLS key path must not contain control characters/);
    expectInvalid({ certPath: CERT, keyPath: KEY, caPath: 'a\tb' }, /TLS CA path must not contain control characters/);
  });
});

describe('InvalidArgumentError', () => {
  it('keeps INVALID_ARGUMENT as the default code', () => {
    expect(new InvalidArgumentError('bad').code).toBe('INVALID_ARGUMENT');
  });
});
