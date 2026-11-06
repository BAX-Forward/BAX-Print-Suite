import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * A throwaway self-signed X.509 v3 certificate (RFC 5280 §4.1) with a P-256 ECDSA key, DER-encoded
 * by hand (ITU-T X.690) because `node:crypto` can parse certificates but not create them.
 */
export interface SelfSignedCert {
  /** PEM certificate. */
  readonly cert: string;
  /** PEM PKCS #8 private key. */
  readonly key: string;
}

const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OBJECT_IDENTIFIER = 0x06;
const UTF8_STRING = 0x0c;
const UTC_TIME = 0x17;
const EXPLICIT_0 = 0xa0;
const X509_V3 = 2;
const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const COMMON_NAME = '2.5.4.3';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SERIAL_BYTES = 8;
const PEM_LINE = 64;

export function selfSignedCert(commonName = 'localhost'): SelfSignedCert {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = der(SEQUENCE, oid(ECDSA_WITH_SHA256));
  const name = der(SEQUENCE, der(SET, der(SEQUENCE, oid(COMMON_NAME), der(UTF8_STRING, Buffer.from(commonName, 'utf8')))));
  const now = Date.now();
  const tbs = der(
    SEQUENCE,
    der(EXPLICIT_0, der(INTEGER, Buffer.from([X509_V3]))),
    der(INTEGER, positiveSerial()),
    algorithm,
    name,
    der(SEQUENCE, utcTime(new Date(now - HOUR_MS)), utcTime(new Date(now + DAY_MS))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  // ECDSA signatures from `sign` are DER `Ecdsa-Sig-Value`s, as X.509 expects.
  const signature = sign('sha256', tbs, privateKey);
  const certificate = der(SEQUENCE, tbs, algorithm, der(BIT_STRING, Buffer.from([0]), signature));
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { cert: toPem('CERTIFICATE', certificate), key: typeof key === 'string' ? key : key.toString('utf8') };
}

function der(tag: number, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const groups = [arc % 128];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) groups.unshift((value % 128) | 0x80);
    bytes.push(...groups);
  }
  return der(OBJECT_IDENTIFIER, Buffer.from(bytes));
}

/** A random serial with the top bit clear, so the DER INTEGER stays positive. */
function positiveSerial(): Buffer {
  const serial = randomBytes(SERIAL_BYTES);
  serial.writeUInt8((serial.readUInt8(0) & 0x7f) | 0x01, 0);
  return serial;
}

/** `YYMMDDHHMMSSZ`; valid for dates before 2050. */
function utcTime(date: Date): Buffer {
  const iso = date.toISOString();
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return der(UTC_TIME, Buffer.from(text, 'ascii'));
}

function toPem(label: string, bytes: Buffer): string {
  const lines = bytes.toString('base64').match(new RegExp(`.{1,${PEM_LINE}}`, 'g')) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
