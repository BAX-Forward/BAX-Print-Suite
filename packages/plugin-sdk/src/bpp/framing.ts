/**
 * LSP-style message framing for BPP v1: each JSON-RPC message is preceded by a
 * `Content-Length: <bytes>\r\n\r\n` header. The body is UTF-8 JSON. Same wire format as the
 * minimal stub in `../stub.ts`.
 */

const HEADER_DELIMITER = Buffer.from('\r\n\r\n', 'ascii');
const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FramingError';
  }
}

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

function parseContentLength(header: string): number {
  let length: number | undefined;
  for (const line of header.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      throw new FramingError(`Malformed header line: ${JSON.stringify(line)}`);
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    if (name === 'content-length') {
      const value = line.slice(separator + 1).trim();
      if (!/^\d+$/.test(value)) {
        throw new FramingError(`Invalid Content-Length: ${JSON.stringify(value)}`);
      }
      length = Number(value);
    }
  }
  if (length === undefined) {
    throw new FramingError('Missing Content-Length header');
  }
  if (length > MAX_MESSAGE_BYTES) {
    throw new FramingError(`Message of ${length} bytes exceeds the ${MAX_MESSAGE_BYTES} byte limit`);
  }
  return length;
}

/**
 * Incremental decoder. Feed it raw chunks; it returns the complete message bodies (as strings)
 * found so far and keeps any trailing partial message buffered.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer | string): string[] {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data]);
    const bodies: string[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_DELIMITER);
      if (headerEnd === -1) {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          throw new FramingError('Header exceeds maximum size');
        }
        break;
      }
      const length = parseContentLength(this.buffer.subarray(0, headerEnd).toString('ascii'));
      const bodyStart = headerEnd + HEADER_DELIMITER.length;
      if (this.buffer.length < bodyStart + length) {
        break;
      }
      bodies.push(this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8'));
      this.buffer = this.buffer.subarray(bodyStart + length);
    }
    return bodies;
  }

  get bufferedBytes(): number {
    return this.buffer.length;
  }
}
