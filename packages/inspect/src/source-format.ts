import { sniffSourceFormat, type SourceFormat } from "@bax-print/core";
import { readVectorHeader, type VectorType } from "./vector-header.js";

/**
 * Spec 035b: the vector format of a file from its bytes, read with the 035a header reader. A file
 * recognised as SVG or DXF but not readable (binary DXF, a malformed root tag) still names its
 * format, so preflight reports it as an unreadable vector file. The file name is never consulted.
 */
export function sniffVectorFormat(bytes: Uint8Array): VectorType | undefined {
  const header = readVectorHeader(bytes);
  return header.kind === "error" ? header.format : header.kind;
}

/**
 * The source format of a job's file: PDF and raster from their magic bytes (Spec 031c), then SVG
 * and DXF from their header (Spec 035b). `undefined` when the bytes are none of them.
 */
export function sniffJobSourceFormat(bytes: Uint8Array): SourceFormat | undefined {
  return sniffSourceFormat(bytes) ?? sniffVectorFormat(bytes);
}
