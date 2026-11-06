import { describe, expect, it } from "vitest";
import { RasterHeaderError, readRasterHeader, sniffRasterType } from "../src/index.js";

/** Spec 031a: header-only facts for PNG, JPEG and TIFF intake, from tiny fixtures built here. */

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function u16be(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** "ok" when the header reads, else the error code. Any other error fails the test. */
function attempt(bytes: Uint8Array): string {
  try {
    readRasterHeader(bytes);
    return "ok";
  } catch (error) {
    if (error instanceof RasterHeaderError) return error.code;
    throw error;
  }
}

function pseudoRandomBytes(seed: number, length: number): number[] {
  let state = seed;
  return Array.from({ length }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  });
}

/** Every prefix of a valid file reads or throws a `RasterHeaderError`, never a RangeError. */
function expectPrefixesBounded(bytes: Uint8Array): void {
  for (let length = 0; length <= bytes.length; length += 1) {
    expect(["ok", "UNKNOWN_FORMAT", "TRUNCATED", "INVALID_HEADER"]).toContain(attempt(bytes.slice(0, length)));
  }
}

// ---- PNG ---------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** CRCs are left zero: the header reader does not verify them. */
function pngChunk(type: string, data: readonly number[]): number[] {
  return [...u32be(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
}

function phys(x: number, y: number, unit: number): number[] {
  return pngChunk("pHYs", [...u32be(x), ...u32be(y), unit]);
}

function png(width: number, height: number, bitDepth: number, colorType: number, chunks: readonly number[][] = []): Uint8Array {
  return Uint8Array.from([
    ...PNG_SIGNATURE,
    ...pngChunk("IHDR", [...u32be(width), ...u32be(height), bitDepth, colorType, 0, 0, 0]),
    ...chunks.flat(),
    ...pngChunk("IDAT", []),
    ...pngChunk("IEND", []),
  ]);
}

describe("PNG headers", () => {
  it("reads size, colour mode and pHYs density in pixels per metre", () => {
    expect(readRasterHeader(png(3000, 2000, 8, 2, [phys(11811, 11811, 1)]))).toEqual({
      type: "png",
      widthPx: 3000,
      heightPx: 2000,
      dpiX: 300,
      dpiY: 300,
      colorMode: "rgb",
      bitsPerSample: 8,
      hasAlpha: false,
    });
  });

  it("rounds dpi to 0.01 and reads each axis", () => {
    const header = readRasterHeader(png(10, 10, 8, 6, [phys(2835, 5670, 1)]));
    expect(header.dpiX).toBe(72.01);
    expect(header.dpiY).toBe(144.02);
    expect(header.hasAlpha).toBe(true);
  });

  it("reads gray with alpha at 16 bits", () => {
    const header = readRasterHeader(png(4, 2, 16, 4));
    expect(header).toMatchObject({ colorMode: "gray", bitsPerSample: 16, hasAlpha: true });
  });

  it("reads indexed colour, with tRNS adding alpha", () => {
    expect(readRasterHeader(png(4, 2, 4, 3))).toMatchObject({ colorMode: "indexed", bitsPerSample: 4, hasAlpha: false });
    expect(readRasterHeader(png(4, 2, 4, 3, [pngChunk("tRNS", [0])])).hasAlpha).toBe(true);
  });

  it("leaves dpi undefined without pHYs or with an aspect-only unit", () => {
    for (const bytes of [png(4, 2, 8, 0), png(4, 2, 8, 0, [phys(11811, 11811, 0)])]) {
      const header = readRasterHeader(bytes);
      expect(header.dpiX).toBeUndefined();
      expect(header.dpiY).toBeUndefined();
      expect(Object.keys(header)).not.toContain("dpiX");
    }
  });

  it("skips unknown ancillary chunks before pHYs", () => {
    const header = readRasterHeader(png(4, 2, 8, 2, [pngChunk("iCCP", [1, 2, 3]), pngChunk("cHRM", [0, 0]), phys(11811, 11811, 1)]));
    expect(header.dpiX).toBe(300);
  });

  it("rejects bad IHDR fields", () => {
    expect(attempt(png(4, 2, 4, 2))).toBe("INVALID_HEADER");
    expect(attempt(png(4, 2, 8, 5))).toBe("INVALID_HEADER");
    expect(attempt(png(0, 2, 8, 2))).toBe("INVALID_HEADER");
    expect(attempt(png(0x80000000, 2, 8, 2))).toBe("INVALID_HEADER");
    const notIhdr = png(4, 2, 8, 2);
    notIhdr.set(ascii("IHDX"), 12);
    expect(attempt(notIhdr)).toBe("INVALID_HEADER");
    expect(attempt(png(4, 2, 8, 2, [pngChunk("pHYs", [0, 0, 0])]))).toBe("INVALID_HEADER");
  });

  it("throws TRUNCATED inside IHDR or a pHYs chunk", () => {
    expect(attempt(png(4, 2, 8, 2).slice(0, 20))).toBe("TRUNCATED");
    // pHYs header at byte 33, data at 41.
    expect(attempt(png(4, 2, 8, 2, [phys(11811, 11811, 1)]).slice(0, 45))).toBe("TRUNCATED");
  });

  it("reads a subarray at a non-zero byte offset", () => {
    const file = png(7, 3, 8, 2);
    const host = new Uint8Array(file.length + 5);
    host.set(file, 5);
    expect(readRasterHeader(host.subarray(5))).toMatchObject({ widthPx: 7, heightPx: 3 });
  });
});

// ---- JPEG --------------------------------------------------------------------------------

function segment(marker: number, data: readonly number[]): number[] {
  return [0xff, marker, ...u16be(data.length + 2), ...data];
}

function jfif(units: number, x: number, y: number): number[] {
  return segment(0xe0, [...ascii("JFIF"), 0, 1, 2, units, ...u16be(x), ...u16be(y), 0, 0]);
}

function adobe(transform: number): number[] {
  return segment(0xee, [...ascii("Adobe"), 0, 100, 0, 0, 0, 0, transform]);
}

function sof(marker: number, width: number, height: number, components: number, precision = 8): number[] {
  const specs = Array.from({ length: components }, (_, index) => [index + 1, 0x11, 0]).flat();
  return segment(marker, [precision, ...u16be(height), ...u16be(width), components, ...specs]);
}

/** SOI, the segments, then a minimal SOS and EOI. */
function jpeg(...segments: number[][]): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...segments.flat(), 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
}

describe("JPEG headers", () => {
  it("reads size, components and JFIF density in dpi", () => {
    expect(readRasterHeader(jpeg(jfif(1, 300, 300), sof(0xc0, 640, 480, 3)))).toEqual({
      type: "jpeg",
      widthPx: 640,
      heightPx: 480,
      dpiX: 300,
      dpiY: 300,
      colorMode: "rgb",
      bitsPerSample: 8,
      hasAlpha: false,
    });
  });

  it("converts dots per cm to dpi", () => {
    const header = readRasterHeader(jpeg(jfif(2, 118, 59), sof(0xc0, 8, 8, 3)));
    expect(header.dpiX).toBe(299.72);
    expect(header.dpiY).toBe(149.86);
  });

  it("reads progressive CMYK and notes the Adobe transform", () => {
    expect(readRasterHeader(jpeg(adobe(2), sof(0xc2, 100, 50, 4)))).toEqual({
      type: "jpeg",
      widthPx: 100,
      heightPx: 50,
      colorMode: "cmyk",
      bitsPerSample: 8,
      hasAlpha: false,
      adobeTransform: 2,
    });
  });

  it("reads 12-bit gray from an extended frame", () => {
    expect(readRasterHeader(jpeg(sof(0xc1, 9, 7, 1, 12)))).toMatchObject({ colorMode: "gray", bitsPerSample: 12 });
  });

  it("does not treat DHT, JPG or DAC as frame headers", () => {
    const lookalike = [8, ...u16be(1), ...u16be(1), 1, 1, 0x11, 0];
    const header = readRasterHeader(
      jpeg(segment(0xc4, lookalike), segment(0xc8, lookalike), segment(0xcc, lookalike), sof(0xc0, 32, 16, 3)),
    );
    expect(header).toMatchObject({ widthPx: 32, heightPx: 16 });
  });

  it("leaves dpi undefined without JFIF or with an aspect-only unit", () => {
    for (const bytes of [jpeg(sof(0xc0, 8, 8, 3)), jpeg(jfif(0, 1, 1), sof(0xc0, 8, 8, 3))]) {
      const header = readRasterHeader(bytes);
      expect(header.dpiX).toBeUndefined();
      expect(header.dpiY).toBeUndefined();
    }
  });

  it("skips fill bytes before a marker", () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xff, ...sof(0xc0, 5, 6, 3)]);
    expect(readRasterHeader(bytes)).toMatchObject({ widthPx: 5, heightPx: 6 });
  });

  it("stops on a bad segment length or a malformed frame", () => {
    expect(attempt(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01, 0, 0]))).toBe("INVALID_HEADER");
    expect(attempt(jpeg(jfif(1, 300, 300)))).toBe("INVALID_HEADER");
    expect(attempt(jpeg(sof(0xc0, 8, 0, 3)))).toBe("INVALID_HEADER");
    expect(attempt(jpeg(segment(0xc0, [8, ...u16be(8), ...u16be(8), 3])))).toBe("INVALID_HEADER");
    expect(attempt(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x02, 0x12, 0x34]))).toBe("INVALID_HEADER");
  });

  it("bounds the marker walk", () => {
    const many = Array.from({ length: 1100 }, () => segment(0xe1, []));
    expect(attempt(jpeg(...many, sof(0xc0, 8, 8, 3)))).toBe("INVALID_HEADER");
  });

  it("throws TRUNCATED when a segment or the frame runs past the end", () => {
    expect(attempt(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1, 2, 3]))).toBe("TRUNCATED");
    // SOF0 marker at byte 2, frame data at 6.
    expect(attempt(jpeg(sof(0xc0, 8, 8, 3)).slice(0, 9))).toBe("TRUNCATED");
    expect(attempt(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe("TRUNCATED");
  });
});

// ---- TIFF --------------------------------------------------------------------------------

const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;

interface TiffField {
  tag: number;
  type: typeof SHORT | typeof LONG | typeof RATIONAL;
  /** RATIONAL values are flat numerator, denominator pairs. */
  values: readonly number[];
}

const short = (tag: number, ...values: number[]): TiffField => ({ tag, type: SHORT, values });
const long = (tag: number, ...values: number[]): TiffField => ({ tag, type: LONG, values });
const rational = (tag: number, numerator: number, denominator: number): TiffField => ({
  tag,
  type: RATIONAL,
  values: [numerator, denominator],
});

function valueBytes(field: TiffField): number {
  return field.values.length * (field.type === SHORT ? 2 : 4);
}

/** Header, one IFD at byte 8, then the values that don't fit inline. */
function tiff(order: "II" | "MM", fields: readonly TiffField[], magic = 42): Uint8Array {
  const littleEndian = order === "II";
  const ifdSize = 2 + fields.length * 12 + 4;
  const overflow = fields.reduce((sum, field) => (valueBytes(field) > 4 ? sum + valueBytes(field) : sum), 0);
  const view = new DataView(new ArrayBuffer(8 + ifdSize + overflow));
  ascii(order).forEach((byte, index) => {
    view.setUint8(index, byte);
  });
  view.setUint16(2, magic, littleEndian);
  view.setUint32(4, 8, littleEndian);
  view.setUint16(8, fields.length, littleEndian);
  let data = 8 + ifdSize;
  fields.forEach((field, index) => {
    const at = 10 + index * 12;
    const size = valueBytes(field);
    view.setUint16(at, field.tag, littleEndian);
    view.setUint16(at + 2, field.type, littleEndian);
    view.setUint32(at + 4, field.type === RATIONAL ? field.values.length / 2 : field.values.length, littleEndian);
    let target = at + 8;
    if (size > 4) {
      view.setUint32(at + 8, data, littleEndian);
      target = data;
      data += size;
    }
    field.values.forEach((value, j) => {
      if (field.type === SHORT) view.setUint16(target + j * 2, value, littleEndian);
      else view.setUint32(target + j * 4, value, littleEndian);
    });
  });
  return new Uint8Array(view.buffer);
}

function patchU32(bytes: Uint8Array, offset: number, value: number, littleEndian: boolean): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(offset, value, littleEndian);
  return copy;
}

const RGB_FIELDS: readonly TiffField[] = [
  long(256, 1200),
  short(257, 800),
  short(258, 8, 8, 8),
  short(262, 2),
  short(277, 3),
  rational(282, 300, 1),
  rational(283, 300, 1),
  short(296, 2),
];
/** Byte offsets in a RGB_FIELDS file: entry i starts at 10 + 12i, its value or offset at +8. */
const BITS_VALUE_OFFSET = 10 + 2 * 12 + 8;
const XRES_VALUE_OFFSET = 10 + 5 * 12 + 8;

describe("TIFF headers", () => {
  it.each(["II", "MM"] as const)("reads the first IFD in %s byte order", (order) => {
    expect(readRasterHeader(tiff(order, RGB_FIELDS))).toEqual({
      type: "tiff",
      widthPx: 1200,
      heightPx: 800,
      dpiX: 300,
      dpiY: 300,
      colorMode: "rgb",
      bitsPerSample: 8,
      hasAlpha: false,
    });
  });

  it("reads separated CMYK with resolution per centimetre", () => {
    const fields = [
      long(256, 10),
      long(257, 20),
      short(258, 8, 8, 8, 8),
      short(262, 5),
      short(277, 4),
      rational(282, 118, 1),
      rational(283, 236, 4),
      short(296, 3),
    ];
    expect(readRasterHeader(tiff("MM", fields))).toMatchObject({ colorMode: "cmyk", dpiX: 299.72, dpiY: 149.86 });
  });

  it("reads alpha from ExtraSamples", () => {
    const base = [long(256, 2), long(257, 2), short(262, 2), short(277, 4)];
    expect(readRasterHeader(tiff("II", [...base, short(338, 2)]))).toMatchObject({ colorMode: "rgb", hasAlpha: true });
    expect(readRasterHeader(tiff("II", [...base, short(338, 1)])).hasAlpha).toBe(true);
    expect(readRasterHeader(tiff("II", [...base, short(338, 0)])).hasAlpha).toBe(false);
  });

  it("maps photometric interpretations", () => {
    const mode = (photometric: number, samples: number): string =>
      readRasterHeader(tiff("II", [long(256, 1), long(257, 1), short(262, photometric), short(277, samples)])).colorMode;
    expect(mode(0, 1)).toBe("gray");
    expect(mode(1, 1)).toBe("gray");
    expect(mode(3, 1)).toBe("indexed");
    expect(mode(6, 3)).toBe("rgb");
    expect(mode(8, 3)).toBe("lab");
    expect(mode(5, 6)).toBe("unknown");
    expect(mode(32844, 1)).toBe("unknown");
  });

  it("defaults BitsPerSample to 1 and leaves dpi undefined without resolution tags", () => {
    const header = readRasterHeader(tiff("MM", [short(256, 3), short(257, 4), short(262, 1)]));
    expect(header).toEqual({ type: "tiff", widthPx: 3, heightPx: 4, colorMode: "gray", bitsPerSample: 1, hasAlpha: false });
  });

  it("leaves dpi undefined when ResolutionUnit has no absolute unit", () => {
    const fields = [short(256, 3), short(257, 4), rational(282, 300, 1), rational(283, 300, 1), short(296, 1)];
    const header = readRasterHeader(tiff("II", fields));
    expect(header.dpiX).toBeUndefined();
    expect(header.dpiY).toBeUndefined();
  });

  it("rejects BigTIFF, a missing width and an IFD inside the header", () => {
    const big = tiff("II", RGB_FIELDS, 43);
    expect(sniffRasterType(big)).toBe("tiff");
    expect(attempt(big)).toBe("INVALID_HEADER");
    expect(attempt(tiff("MM", [short(43, 43)], 43))).toBe("INVALID_HEADER");
    expect(attempt(tiff("II", RGB_FIELDS.slice(1)))).toBe("INVALID_HEADER");
    expect(attempt(patchU32(tiff("II", RGB_FIELDS), 4, 4, true))).toBe("INVALID_HEADER");
  });

  it.each(["II", "MM"] as const)("never reads past the end through %s offsets", (order) => {
    const littleEndian = order === "II";
    const file = tiff(order, RGB_FIELDS);
    expect(attempt(patchU32(file, 4, 0x7fffffff, littleEndian))).toBe("TRUNCATED");
    expect(attempt(patchU32(file, BITS_VALUE_OFFSET, 0xfffffff0, littleEndian))).toBe("TRUNCATED");
    expect(attempt(patchU32(file, BITS_VALUE_OFFSET, file.length - 2, littleEndian))).toBe("TRUNCATED");
    expect(attempt(patchU32(file, XRES_VALUE_OFFSET, file.length - 4, littleEndian))).toBe("TRUNCATED");
    const manyEntries = file.slice();
    new DataView(manyEntries.buffer).setUint16(8, 500, littleEndian);
    expect(attempt(manyEntries)).toBe("TRUNCATED");
  });
});

// ---- Format detection and hostile input ---------------------------------------------------

describe("format detection and bounds", () => {
  it("sniffs each format from its magic bytes", () => {
    expect(sniffRasterType(png(1, 1, 8, 0))).toBe("png");
    expect(sniffRasterType(jpeg(sof(0xc0, 1, 1, 1)))).toBe("jpeg");
    expect(sniffRasterType(tiff("II", RGB_FIELDS))).toBe("tiff");
    expect(sniffRasterType(tiff("MM", RGB_FIELDS))).toBe("tiff");
    expect(sniffRasterType(Uint8Array.from(ascii("GIF89a")))).toBeUndefined();
    expect(sniffRasterType(new Uint8Array(0))).toBeUndefined();
  });

  it("throws UNKNOWN_FORMAT for garbage and short input", () => {
    for (const bytes of [new Uint8Array(0), Uint8Array.from([1, 2, 3, 4, 5]), Uint8Array.from(PNG_SIGNATURE.slice(0, 7))]) {
      expect(attempt(bytes)).toBe("UNKNOWN_FORMAT");
    }
    const error = (() => {
      try {
        readRasterHeader(Uint8Array.from(ascii("%PDF-1.7")));
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(RasterHeaderError);
    expect(error).toMatchObject({ name: "RasterHeaderError", code: "UNKNOWN_FORMAT" });
  });

  it("returns a frozen header", () => {
    expect(Object.isFrozen(readRasterHeader(png(1, 1, 8, 0)))).toBe(true);
    expect(Object.isFrozen(readRasterHeader(jpeg(sof(0xc0, 1, 1, 1))))).toBe(true);
    expect(Object.isFrozen(readRasterHeader(tiff("II", RGB_FIELDS)))).toBe(true);
  });

  it("bounds every prefix of a valid file", () => {
    expectPrefixesBounded(png(3, 3, 8, 2, [phys(11811, 11811, 1)]));
    expectPrefixesBounded(jpeg(jfif(1, 300, 300), adobe(1), sof(0xc0, 3, 3, 3)));
    expectPrefixesBounded(tiff("II", RGB_FIELDS));
    expectPrefixesBounded(tiff("MM", RGB_FIELDS));
  });

  it("bounds random bytes behind each magic", () => {
    const magics = [PNG_SIGNATURE, [0xff, 0xd8, 0xff], [0x49, 0x49, 42, 0], [0x4d, 0x4d, 0, 42]];
    for (const magic of magics) {
      for (let seed = 1; seed <= 64; seed += 1) {
        const bytes = Uint8Array.from([...magic, ...pseudoRandomBytes(seed, 96)]);
        expect(["ok", "TRUNCATED", "INVALID_HEADER"]).toContain(attempt(bytes));
      }
    }
  });
});
