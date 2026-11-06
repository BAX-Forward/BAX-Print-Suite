/**
 * Spec 031c: the format of a job's source file, detected from its leading bytes. Spec 035b adds
 * `svg` and `dxf`; those have no fixed magic bytes, so {@link sniffSourceFormat} does not detect
 * them. The inspect package's `sniffJobSourceFormat` adds them from its vector header reader.
 */

export type SourceFormat = 'pdf' | 'png' | 'jpeg' | 'tiff' | 'svg' | 'dxf';

export const SOURCE_FORMATS: readonly SourceFormat[] = ['pdf', 'png', 'jpeg', 'tiff', 'svg', 'dxf'];

/** Detects a source format from a file's bytes, never from its name. */
export type SourceFormatSniffer = (bytes: Uint8Array) => SourceFormat | undefined;

const SIGNATURES: readonly { readonly format: SourceFormat; readonly prefix: readonly number[] }[] = [
  // ISO 32000-1 §7.5.2: the header line `%PDF-`.
  { format: 'pdf', prefix: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // PNG (ISO/IEC 15948) signature.
  { format: 'png', prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // JPEG (ITU-T T.81) SOI marker followed by the next marker's 0xFF.
  { format: 'jpeg', prefix: [0xff, 0xd8, 0xff] },
  // TIFF 6.0 byte order mark and 42, little and big endian.
  { format: 'tiff', prefix: [0x49, 0x49, 0x2a, 0x00] },
  { format: 'tiff', prefix: [0x4d, 0x4d, 0x00, 0x2a] },
];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

/** The source format from magic bytes (PDF and raster), or `undefined` when the bytes match none of them. */
export function sniffSourceFormat(bytes: Uint8Array): SourceFormat | undefined {
  return SIGNATURES.find((signature) => startsWith(bytes, signature.prefix))?.format;
}
