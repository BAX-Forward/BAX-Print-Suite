import { createHash } from 'node:crypto';
import { canonicalJson } from '@bax-print/core';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Content hash used by color setup revisions. */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
