/**
 * Header-only facts for raster intake (Spec 031a): pixel size, resolution and colour mode of
 * PNG, JPEG and TIFF files, read from their headers without decoding any pixel data.
 * Every read is bounded by the buffer length; malformed input throws a `RasterHeaderError`.
 */

export type RasterType = "png" | "jpeg" | "tiff";
export type RasterColorMode = "gray" | "rgb" | "cmyk" | "indexed" | "lab" | "unknown";
export type RasterHeaderErrorCode = "UNKNOWN_FORMAT" | "TRUNCATED" | "INVALID_HEADER";

export interface RasterHeader {
  readonly type: RasterType;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Dots per inch, rounded to 0.01; absent when the header carries no absolute density. */
  readonly dpiX?: number;
  readonly dpiY?: number;
  readonly colorMode: RasterColorMode;
  readonly bitsPerSample?: number;
  readonly hasAlpha: boolean;
  /** JPEG only: the Adobe APP14 colour transform (0 none, 1 YCbCr, 2 YCCK) when present. */
  readonly adobeTransform?: number;
}

export class RasterHeaderError extends Error {
  readonly code: RasterHeaderErrorCode;

  constructor(code: RasterHeaderErrorCode, message: string) {
    super(message);
    this.name = "RasterHeaderError";
    this.code = code;
  }
}

const METRES_PER_INCH = 0.0254;
const CM_PER_INCH = 2.54;
/** Upper bounds on header walks, so hostile input can't make a scan unbounded. */
const MAX_PNG_CHUNKS = 256;
const MAX_JPEG_MARKERS = 1024;
const MAX_TIFF_VALUES = 16;

function invalid(message: string): RasterHeaderError {
  return new RasterHeaderError("INVALID_HEADER", message);
}

/** Bounds-checked reads over a byte buffer; a read past the end throws `TRUNCATED`. */
class ByteReader {
  readonly length: number;
  private readonly view: DataView;
  private readonly littleEndian: boolean;

  constructor(bytes: Uint8Array, littleEndian: boolean) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.length = bytes.byteLength;
    this.littleEndian = littleEndian;
  }

  has(offset: number, size: number): boolean {
    return Number.isInteger(offset) && offset >= 0 && size >= 0 && offset + size <= this.length;
  }

  require(offset: number, size: number, what: string): void {
    if (this.has(offset, size)) return;
    throw new RasterHeaderError("TRUNCATED", `${what} at byte ${offset} runs past the end of the ${this.length}-byte input`);
  }

  u8(offset: number, what = "header"): number {
    this.require(offset, 1, what);
    return this.view.getUint8(offset);
  }

  i8(offset: number, what = "header"): number {
    this.require(offset, 1, what);
    return this.view.getInt8(offset);
  }

  u16(offset: number, what = "header"): number {
    this.require(offset, 2, what);
    return this.view.getUint16(offset, this.littleEndian);
  }

  i16(offset: number, what = "header"): number {
    this.require(offset, 2, what);
    return this.view.getInt16(offset, this.littleEndian);
  }

  u32(offset: number, what = "header"): number {
    this.require(offset, 4, what);
    return this.view.getUint32(offset, this.littleEndian);
  }

  i32(offset: number, what = "header"): number {
    this.require(offset, 4, what);
    return this.view.getInt32(offset, this.littleEndian);
  }

  f32(offset: number, what = "header"): number {
    this.require(offset, 4, what);
    return this.view.getFloat32(offset, this.littleEndian);
  }

  f64(offset: number, what = "header"): number {
    this.require(offset, 8, what);
    return this.view.getFloat64(offset, this.littleEndian);
  }

  ascii(offset: number, size: number, what = "header"): string {
    this.require(offset, size, what);
    let text = "";
    for (let i = 0; i < size; i += 1) text += String.fromCharCode(this.view.getUint8(offset + i));
    return text;
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.byteLength >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SOI = [0xff, 0xd8, 0xff] as const;
const TIFF_MAGIC = 42;
const BIGTIFF_MAGIC = 43;
const TIFF_PREFIXES: readonly (readonly number[])[] = [
  [0x49, 0x49, TIFF_MAGIC, 0x00],
  [0x49, 0x49, BIGTIFF_MAGIC, 0x00],
  [0x4d, 0x4d, 0x00, TIFF_MAGIC],
  [0x4d, 0x4d, 0x00, BIGTIFF_MAGIC],
];

/** The raster format named by the leading magic bytes, or `undefined`. BigTIFF sniffs as `tiff`. */
export function sniffRasterType(bytes: Uint8Array): RasterType | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return "png";
  if (startsWith(bytes, JPEG_SOI)) return "jpeg";
  if (TIFF_PREFIXES.some((prefix) => startsWith(bytes, prefix))) return "tiff";
  return undefined;
}

/** Reads the header facts of a PNG, JPEG or TIFF file. The result is frozen. */
export function readRasterHeader(bytes: Uint8Array): RasterHeader {
  const type = sniffRasterType(bytes);
  if (type === "png") return readPng(bytes);
  if (type === "jpeg") return readJpeg(bytes);
  if (type === "tiff") return readTiff(bytes);
  throw new RasterHeaderError("UNKNOWN_FORMAT", "Input is not a PNG, JPEG or TIFF file");
}

interface HeaderDraft {
  type: RasterType;
  widthPx: number;
  heightPx: number;
  dpiX: number | undefined;
  dpiY: number | undefined;
  colorMode: RasterColorMode;
  bitsPerSample: number | undefined;
  hasAlpha: boolean;
  adobeTransform?: number | undefined;
}

function freezeHeader(draft: HeaderDraft): RasterHeader {
  return Object.freeze({
    type: draft.type,
    widthPx: draft.widthPx,
    heightPx: draft.heightPx,
    ...(draft.dpiX === undefined ? {} : { dpiX: draft.dpiX }),
    ...(draft.dpiY === undefined ? {} : { dpiY: draft.dpiY }),
    colorMode: draft.colorMode,
    ...(draft.bitsPerSample === undefined ? {} : { bitsPerSample: draft.bitsPerSample }),
    hasAlpha: draft.hasAlpha,
    ...(draft.adobeTransform === undefined ? {} : { adobeTransform: draft.adobeTransform }),
  });
}

/** Converts a density in units-per-`unitsPerInch` to dpi, rounded to 0.01; `undefined` unless positive. */
function toDpi(density: number | undefined, unitsPerInch: number): number | undefined {
  if (density === undefined || Number.isFinite(density) === false || density <= 0) return undefined;
  return Math.round(density * unitsPerInch * 100) / 100;
}

function isPositiveInteger(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function dimensions(widthPx: number | undefined, heightPx: number | undefined, format: string): { widthPx: number; heightPx: number } {
  if (isPositiveInteger(widthPx) && isPositiveInteger(heightPx)) return { widthPx, heightPx };
  throw invalid(`${format}: image width and height must be positive integers`);
}

// ---- PNG (ISO/IEC 15948 / W3C PNG) -------------------------------------------------------

const PNG_IHDR_LENGTH = 13;
const PNG_IHDR_DATA = 16;
const PNG_AFTER_IHDR = PNG_IHDR_DATA + PNG_IHDR_LENGTH + 4;
const PNG_MAX_INT = 0x7fffffff;
const PNG_UNIT_METRE = 1;

interface PngColorType {
  mode: RasterColorMode;
  alpha: boolean;
  depths: readonly number[];
}

/** IHDR colour types and their allowed bit depths (PNG §11.2.2, Table 11.1). */
const PNG_COLOR_TYPES: ReadonlyMap<number, PngColorType> = new Map([
  [0, { mode: "gray", alpha: false, depths: [1, 2, 4, 8, 16] }],
  [2, { mode: "rgb", alpha: false, depths: [8, 16] }],
  [3, { mode: "indexed", alpha: false, depths: [1, 2, 4, 8] }],
  [4, { mode: "gray", alpha: true, depths: [8, 16] }],
  [6, { mode: "rgb", alpha: true, depths: [8, 16] }],
]);

function readPng(bytes: Uint8Array): RasterHeader {
  const r = new ByteReader(bytes, false);
  r.require(PNG_SIGNATURE.length, 8 + PNG_IHDR_LENGTH, "PNG IHDR chunk");
  if (r.u32(8) === PNG_IHDR_LENGTH && r.ascii(12, 4) === "IHDR") {
    const size = dimensions(r.u32(PNG_IHDR_DATA), r.u32(PNG_IHDR_DATA + 4), "PNG");
    const bitDepth = r.u8(PNG_IHDR_DATA + 8);
    const colorTypeCode = r.u8(PNG_IHDR_DATA + 9);
    const colorType = PNG_COLOR_TYPES.get(colorTypeCode);
    if (colorType === undefined || colorType.depths.includes(bitDepth) === false) {
      throw invalid(`PNG: unsupported colour type and bit depth ${colorTypeCode}/${bitDepth}`);
    }
    if (size.widthPx > PNG_MAX_INT || size.heightPx > PNG_MAX_INT) throw invalid("PNG: image dimensions exceed 2^31-1");
    const extras = scanPngChunks(r);
    return freezeHeader({
      type: "png",
      ...size,
      dpiX: extras.dpiX,
      dpiY: extras.dpiY,
      colorMode: colorType.mode,
      bitsPerSample: bitDepth,
      hasAlpha: colorType.alpha || extras.transparency,
    });
  }
  throw invalid("PNG: the first chunk must be a 13-byte IHDR");
}

interface PngExtras {
  dpiX: number | undefined;
  dpiY: number | undefined;
  /** A tRNS chunk adds alpha to gray, RGB and indexed images. */
  transparency: boolean;
}

/** Walks the ancillary chunks before the first IDAT for pHYs and tRNS. Other chunks are skipped unread. */
function scanPngChunks(r: ByteReader): PngExtras {
  let extras: PngExtras = { dpiX: undefined, dpiY: undefined, transparency: false };
  let offset = PNG_AFTER_IHDR;
  for (let n = 0; n < MAX_PNG_CHUNKS && r.has(offset, 8); n += 1) {
    const length = r.u32(offset);
    const type = r.ascii(offset + 4, 4);
    if (length > PNG_MAX_INT) throw invalid(`PNG: chunk length ${length} exceeds 2^31-1`);
    if (type === "IDAT" || type === "IEND") break;
    const data = offset + 8;
    if (type === "pHYs") extras = { ...extras, ...readPhys(r, data, length) };
    if (type === "tRNS") extras = { ...extras, transparency: true };
    offset = data + length + 4;
  }
  return extras;
}

function readPhys(r: ByteReader, data: number, length: number): Pick<PngExtras, "dpiX" | "dpiY"> {
  if (length === 9) {
    r.require(data, 9, "PNG pHYs chunk");
    const unitsPerInch = r.u8(data + 8) === PNG_UNIT_METRE ? METRES_PER_INCH : undefined;
    if (unitsPerInch === undefined) return { dpiX: undefined, dpiY: undefined };
    return { dpiX: toDpi(r.u32(data), unitsPerInch), dpiY: toDpi(r.u32(data + 4), unitsPerInch) };
  }
  throw invalid(`PNG: pHYs chunk must be 9 bytes, not ${length}`);
}

// ---- JPEG (ITU-T T.81, JFIF T.871, Adobe APP14) ------------------------------------------

const JPEG_TEM = 0x01;
const JPEG_RST0 = 0xd0;
const JPEG_SOI_CODE = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
const JPEG_APP0 = 0xe0;
const JPEG_APP14 = 0xee;
const JPEG_SOF0 = 0xc0;
const JPEG_SOF15 = 0xcf;
/** DHT, JPG and DAC share the SOFn code range but are not frame headers (T.81 Table B.1). */
const JPEG_NOT_SOF: ReadonlySet<number> = new Set([0xc4, 0xc8, 0xcc]);
const JPEG_UNIT_DPI = 1;
const JPEG_UNIT_DPCM = 2;
const JPEG_COLOR_MODES: ReadonlyMap<number, RasterColorMode> = new Map([
  [1, "gray"],
  [3, "rgb"],
  [4, "cmyk"],
]);

function isStandaloneMarker(code: number): boolean {
  return code === JPEG_TEM || (code >= JPEG_RST0 && code <= JPEG_SOI_CODE);
}

function isFrameMarker(code: number): boolean {
  return code >= JPEG_SOF0 && code <= JPEG_SOF15 && JPEG_NOT_SOF.has(code) === false;
}

/** Reads the marker at `offset`, skipping 0xFF fill bytes (T.81 §B.1.1.2). */
function readMarker(r: ByteReader, offset: number): { code: number; next: number } {
  if (r.u8(offset, "JPEG marker") < 0xff) throw invalid(`JPEG: expected a marker at byte ${offset}`);
  let at = offset + 1;
  while (r.u8(at, "JPEG marker") === 0xff) at += 1;
  return { code: r.u8(at, "JPEG marker"), next: at + 1 };
}

interface JpegExtras {
  dpiX: number | undefined;
  dpiY: number | undefined;
  adobeTransform: number | undefined;
}

function readJpeg(bytes: Uint8Array): RasterHeader {
  const r = new ByteReader(bytes, false);
  let density: Pick<JpegExtras, "dpiX" | "dpiY"> | undefined;
  let adobeTransform: number | undefined;
  let offset = 2;
  for (let n = 0; n < MAX_JPEG_MARKERS; n += 1) {
    const { code, next } = readMarker(r, offset);
    if (isStandaloneMarker(code)) {
      offset = next;
    } else {
      if (code === 0x00 || code === JPEG_SOS || code === JPEG_EOI) throw invalid("JPEG: no frame header before scan data");
      const length = r.u16(next, "JPEG segment length");
      if (length < 2) throw invalid(`JPEG: segment length ${length} at byte ${next} is too short`);
      const data = next + 2;
      if (isFrameMarker(code)) {
        return readJpegFrame(r, data, length, { dpiX: density?.dpiX, dpiY: density?.dpiY, adobeTransform });
      }
      if (code === JPEG_APP0 && density === undefined) density = readJfifDensity(r, data, length);
      if (code === JPEG_APP14 && adobeTransform === undefined) adobeTransform = readAdobeTransform(r, data, length);
      offset = next + length;
    }
  }
  throw invalid(`JPEG: no frame header within ${MAX_JPEG_MARKERS} markers`);
}

/** JFIF APP0: "JFIF\0", version, units, Xdensity, Ydensity (T.871 §10.1). */
function readJfifDensity(r: ByteReader, data: number, length: number): Pick<JpegExtras, "dpiX" | "dpiY"> | undefined {
  const isJfif = length >= 2 + 12 && r.ascii(data, 5, "JFIF APP0") === "JFIF\u0000";
  if (isJfif === false) return undefined;
  const units = r.u8(data + 7, "JFIF APP0");
  const unitsPerInch = units === JPEG_UNIT_DPI ? 1 : units === JPEG_UNIT_DPCM ? CM_PER_INCH : undefined;
  if (unitsPerInch === undefined) return { dpiX: undefined, dpiY: undefined };
  return {
    dpiX: toDpi(r.u16(data + 8, "JFIF APP0"), unitsPerInch),
    dpiY: toDpi(r.u16(data + 10, "JFIF APP0"), unitsPerInch),
  };
}

/** Adobe APP14: "Adobe", version, flags0, flags1, transform. */
function readAdobeTransform(r: ByteReader, data: number, length: number): number | undefined {
  const isAdobe = length >= 2 + 12 && r.ascii(data, 5, "Adobe APP14") === "Adobe";
  return isAdobe ? r.u8(data + 11, "Adobe APP14") : undefined;
}

/** SOFn: precision, lines, samples per line, component count, then 3 bytes per component (T.81 §B.2.2). */
function readJpegFrame(r: ByteReader, data: number, length: number, extras: JpegExtras): RasterHeader {
  r.require(data, 6, "JPEG frame header");
  const precision = r.u8(data);
  const components = r.u8(data + 5);
  const lengthMatches = components > 0 && length === 8 + 3 * components;
  if (lengthMatches === false) {
    throw invalid(`JPEG: frame header length ${length} does not match ${components} components`);
  }
  r.require(data, length - 2, "JPEG frame header");
  // A height of 0 defers to a DNL marker after the first scan, which a header read never reaches.
  const size = dimensions(r.u16(data + 3), r.u16(data + 1), "JPEG");
  return freezeHeader({
    type: "jpeg",
    ...size,
    dpiX: extras.dpiX,
    dpiY: extras.dpiY,
    colorMode: JPEG_COLOR_MODES.get(components) ?? "unknown",
    bitsPerSample: precision,
    hasAlpha: false,
    adobeTransform: extras.adobeTransform,
  });
}

// ---- TIFF (TIFF 6.0) ---------------------------------------------------------------------

const TIFF_HEADER_LENGTH = 8;
const TIFF_ENTRY_LENGTH = 12;
const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_PHOTOMETRIC = 262;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_X_RESOLUTION = 282;
const TAG_Y_RESOLUTION = 283;
const TAG_RESOLUTION_UNIT = 296;
const TAG_EXTRA_SAMPLES = 338;
const TIFF_TAGS_READ: ReadonlySet<number> = new Set([
  TAG_IMAGE_WIDTH,
  TAG_IMAGE_LENGTH,
  TAG_BITS_PER_SAMPLE,
  TAG_PHOTOMETRIC,
  TAG_SAMPLES_PER_PIXEL,
  TAG_X_RESOLUTION,
  TAG_Y_RESOLUTION,
  TAG_RESOLUTION_UNIT,
  TAG_EXTRA_SAMPLES,
]);
const RESOLUTION_UNIT_INCH = 2;
const RESOLUTION_UNIT_CM = 3;
const PHOTOMETRIC_SEPARATED = 5;
/** ExtraSamples 1 (associated alpha) and 2 (unassociated alpha); 0 is unspecified data. */
const EXTRA_SAMPLE_ALPHA: ReadonlySet<number> = new Set([1, 2]);

/** Field type byte sizes (TIFF 6.0 §2, plus FLOAT and DOUBLE). */
const TIFF_TYPE_SIZES: ReadonlyMap<number, number> = new Map([
  [1, 1],
  [2, 1],
  [3, 2],
  [4, 4],
  [5, 8],
  [6, 1],
  [7, 1],
  [8, 2],
  [9, 4],
  [10, 8],
  [11, 4],
  [12, 8],
]);

/** PhotometricInterpretation values other than Separated, which depends on the ink count. */
const TIFF_COLOR_MODES: ReadonlyMap<number, RasterColorMode> = new Map([
  [0, "gray"],
  [1, "gray"],
  [2, "rgb"],
  [3, "indexed"],
  [6, "rgb"],
  [8, "lab"],
  [9, "lab"],
  [10, "lab"],
]);

interface IfdEntry {
  type: number;
  count: number;
  size: number;
  /** Absolute offset of the first value, already bounds-checked for all `count` values. */
  offset: number;
}

function readTiff(bytes: Uint8Array): RasterHeader {
  const r = new ByteReader(bytes, bytes[0] === 0x49);
  if (r.u16(2) === BIGTIFF_MAGIC) throw invalid("TIFF: BigTIFF is not supported");
  const ifd = r.u32(4);
  if (ifd < TIFF_HEADER_LENGTH) throw invalid(`TIFF: first IFD offset ${ifd} points into the header`);
  const count = r.u16(ifd, "TIFF IFD");
  if (count === 0) throw invalid("TIFF: the first IFD has no entries");
  r.require(ifd + 2, count * TIFF_ENTRY_LENGTH, "TIFF IFD entries");
  const entries = new Map<number, IfdEntry>();
  for (let i = 0; i < count; i += 1) {
    const at = ifd + 2 + i * TIFF_ENTRY_LENGTH;
    const tag = r.u16(at);
    if (TIFF_TAGS_READ.has(tag) && entries.has(tag) === false) entries.set(tag, readIfdEntry(r, tag, at));
  }
  const field = (tag: number): number | undefined => {
    const entry = entries.get(tag);
    return entry === undefined ? undefined : entryValue(r, entry, 0);
  };

  const size = dimensions(field(TAG_IMAGE_WIDTH), field(TAG_IMAGE_LENGTH), "TIFF");
  const bits = field(TAG_BITS_PER_SAMPLE) ?? 1;
  const samples = field(TAG_SAMPLES_PER_PIXEL) ?? 1;
  const extra = entries.get(TAG_EXTRA_SAMPLES);
  const extraValues = extra === undefined ? [] : entryValues(r, extra, MAX_TIFF_VALUES);
  const unit = field(TAG_RESOLUTION_UNIT) ?? RESOLUTION_UNIT_INCH;
  const unitsPerInch = unit === RESOLUTION_UNIT_INCH ? 1 : unit === RESOLUTION_UNIT_CM ? CM_PER_INCH : undefined;
  return freezeHeader({
    type: "tiff",
    ...size,
    dpiX: unitsPerInch === undefined ? undefined : toDpi(field(TAG_X_RESOLUTION), unitsPerInch),
    dpiY: unitsPerInch === undefined ? undefined : toDpi(field(TAG_Y_RESOLUTION), unitsPerInch),
    colorMode: tiffColorMode(field(TAG_PHOTOMETRIC), samples - (extra?.count ?? 0)),
    bitsPerSample: Number.isInteger(bits) && bits > 0 ? bits : undefined,
    hasAlpha: extraValues.some((value) => EXTRA_SAMPLE_ALPHA.has(value)),
  });
}

/** Locates an entry's values: inline when they fit in 4 bytes, else at the offset (TIFF 6.0 §2). */
function readIfdEntry(r: ByteReader, tag: number, at: number): IfdEntry {
  const type = r.u16(at + 2);
  const count = r.u32(at + 4);
  const size = TIFF_TYPE_SIZES.get(type);
  if (size === undefined) throw invalid(`TIFF: tag ${tag} has unknown field type ${type}`);
  if (count === 0) throw invalid(`TIFF: tag ${tag} has no values`);
  const total = size * count;
  const offset = total <= 4 ? at + 8 : r.u32(at + 8);
  r.require(offset, total, `TIFF tag ${tag} value`);
  return { type, count, size, offset };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? Number.NaN : numerator / denominator;
}

function entryValue(r: ByteReader, entry: IfdEntry, index: number): number {
  const at = entry.offset + index * entry.size;
  switch (entry.type) {
    case 1:
    case 7:
      return r.u8(at);
    case 3:
      return r.u16(at);
    case 4:
      return r.u32(at);
    case 5:
      return ratio(r.u32(at), r.u32(at + 4));
    case 6:
      return r.i8(at);
    case 8:
      return r.i16(at);
    case 9:
      return r.i32(at);
    case 10:
      return ratio(r.i32(at), r.i32(at + 4));
    case 11:
      return r.f32(at);
    case 12:
      return r.f64(at);
    default:
      // ASCII is not a number.
      return Number.NaN;
  }
}

function entryValues(r: ByteReader, entry: IfdEntry, max: number): number[] {
  return Array.from({ length: Math.min(entry.count, max) }, (_, index) => entryValue(r, entry, index));
}

function tiffColorMode(photometric: number | undefined, colorSamples: number): RasterColorMode {
  if (photometric === PHOTOMETRIC_SEPARATED) return colorSamples === 4 ? "cmyk" : "unknown";
  return photometric === undefined ? "unknown" : (TIFF_COLOR_MODES.get(photometric) ?? "unknown");
}
