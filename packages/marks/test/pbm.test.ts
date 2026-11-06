import { describe, expect, it } from "vitest";
import {
  MAX_PBM_PIXELS,
  MAX_PBM_SIDE,
  MarkSpecError,
  PbmError,
  packPlane1bpp,
  parsePbmP4,
  unpackPlane1bpp,
  writePbmP4,
  type PbmErrorCode,
} from "../src/index.js";

const ROUND_TRIPS = 250;
const SEED = 0x042b;

/** Deterministic PRNG (mulberry32) in [0, 1). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

/** A header followed by `dataLength` zero bytes. */
function file(header: string, dataLength: number): Uint8Array {
  const head = ascii(header);
  const out = new Uint8Array(head.length + dataLength);
  out.set(head, 0);
  return out;
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

function expectCode(fn: () => unknown, code: PbmErrorCode): PbmError {
  const e = thrown(fn);
  expect(e).toBeInstanceOf(PbmError);
  expect(e).toBeInstanceOf(MarkSpecError);
  expect(e).toMatchObject({ code });
  if (e instanceof PbmError) return e;
  throw new Error("expected a PbmError");
}

const NINE_BY_TWO_PLANE = Uint8Array.from([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 255]);
// "P4\n9 2\n" then two rows of two bytes, bit 1 = ink = black.
const NINE_BY_TWO_FILE = [0x50, 0x34, 0x0a, 0x39, 0x20, 0x32, 0x0a, 0xff, 0x80, 0x80, 0x80];

describe("writePbmP4 known bytes", () => {
  it("writes a 9 x 2 plane as header and raw rows", () => {
    const packed = packPlane1bpp({ width: 9, height: 2, plane: NINE_BY_TWO_PLANE });
    expect([...writePbmP4(packed)]).toEqual(NINE_BY_TWO_FILE);
  });

  it("writes an ASCII header from the integers", () => {
    const out = writePbmP4({ width: MAX_PBM_SIDE, height: 1, rowBytes: 8192, data: new Uint8Array(8192) });
    const header = String.fromCharCode(...out.subarray(0, 11));
    expect(header).toBe("P4\n65535 1\n");
    expect(out.length).toBe(11 + 8192);
  });

  it("leaves the input unchanged", () => {
    const data = Uint8Array.from([0xff, 0x80, 0x80, 0x80]);
    writePbmP4({ width: 9, height: 2, rowBytes: 2, data });
    expect([...data]).toEqual([0xff, 0x80, 0x80, 0x80]);
  });
});

describe("parsePbmP4 known bytes", () => {
  it("parses the 9 x 2 file", () => {
    const parsed = parsePbmP4(Uint8Array.from(NINE_BY_TWO_FILE));
    expect(parsed).toEqual({ width: 9, height: 2, rowBytes: 2, data: Uint8Array.from([0xff, 0x80, 0x80, 0x80]) });
    expect(unpackPlane1bpp(parsed)).toEqual(NINE_BY_TWO_PLANE);
  });

  it("returns a copy of the data", () => {
    const bytes = Uint8Array.from(NINE_BY_TWO_FILE);
    const parsed = parsePbmP4(bytes);
    bytes.fill(0);
    expect([...parsed.data]).toEqual([0xff, 0x80, 0x80, 0x80]);
  });
});

describe("round trip", () => {
  it(`parse(write(pack(plane))) unpacks to the plane for ${ROUND_TRIPS} seeded random planes`, () => {
    const random = rng(SEED);
    let oddWidths = 0;
    for (let n = 0; n < ROUND_TRIPS; n++) {
      const width = 1 + Math.floor(random() * 40);
      const height = 1 + Math.floor(random() * 12);
      const density = random();
      const input = Uint8Array.from({ length: width * height }, () => (random() < density ? 255 : 0));
      if (width % 8 !== 0) oddWidths++;

      const packed = packPlane1bpp({ width, height, plane: input });
      const parsed = parsePbmP4(writePbmP4(packed));
      expect(parsed).toEqual(packed);
      expect(unpackPlane1bpp(parsed)).toEqual(input);
    }
    expect(oddWidths).toBeGreaterThan(ROUND_TRIPS / 2);
  });
});

describe("parsePbmP4 header errors", () => {
  it.each([
    { label: "empty input", header: "" },
    { label: "magic only", header: "P" },
    { label: "P5 magic", header: "P5\n9 2\n" },
    { label: "lowercase magic", header: "p4\n9 2\n" },
    { label: "plain PBM P1", header: "P1\n9 2\n" },
    { label: "leading whitespace", header: " P4\n9 2\n" },
    { label: "a comment line", header: "P4\n# made here\n9 2\n" },
    { label: "a comment after the magic", header: "P4 # c\n9 2\n" },
    { label: "a comment after the height", header: "P4\n9 2 # c\n" },
    { label: "a tab after the magic", header: "P4\t9 2\n" },
    { label: "a space after the magic", header: "P4 9 2\n" },
    { label: "a tab between the sides", header: "P4\n9\t2\n" },
    { label: "a newline between the sides", header: "P4\n9\n2\n" },
    { label: "two spaces between the sides", header: "P4\n9  2\n" },
    { label: "CRLF line ends", header: "P4\r\n9 2\r\n" },
    { label: "CR before the data", header: "P4\n9 2\r\n" },
    { label: "a missing final newline", header: "P4\n9 2" },
    { label: "a leading zero width", header: "P4\n09 2\n" },
    { label: "a leading zero height", header: "P4\n9 02\n" },
    { label: "a negative width", header: "P4\n-9 2\n" },
    { label: "a negative height", header: "P4\n9 -2\n" },
    { label: "a plus sign", header: "P4\n+9 2\n" },
    { label: "a decimal point", header: "P4\n9.0 2\n" },
    { label: "an exponent", header: "P4\n9e0 2\n" },
    { label: "a missing height", header: "P4\n9 \n" },
  ])("rejects $label", ({ header }) => {
    expectCode(() => parsePbmP4(file(header, 4)), "PBM_INVALID_HEADER");
  });

  it("counts a second newline after the header as data", () => {
    expectCode(() => parsePbmP4(file("P4\n9 2\n\n", 4)), "PBM_DATA_LENGTH");
  });
});

describe("parsePbmP4 size errors", () => {
  it.each(["P4\n0 2\n", "P4\n9 0\n", "P4\n0 0\n"])("rejects a zero size in %j", (header) => {
    expectCode(() => parsePbmP4(file(header, 0)), "PBM_INVALID_SIZE");
  });

  // No data follows these headers: the size caps fail before the data length is checked or any buffer is allocated.
  it.each([
    "P4\n65536 1\n",
    "P4\n1 65536\n",
    "P4\n65535 65535\n",
    "P4\n10001 10000\n",
    "P4\n123456 1\n",
    "P4\n99999999999999999999999999 1\n",
    "P4\n1 99999999999999999999999999\n",
  ])("rejects a huge size in %j before allocating", (header) => {
    expectCode(() => parsePbmP4(file(header, 0)), "PBM_TOO_LARGE");
  });

  it("caps digits without reading a long run of them", () => {
    const e = expectCode(() => parsePbmP4(file(`P4\n${"9".repeat(100_000)} 1\n`, 0)), "PBM_TOO_LARGE");
    expect(e.message).toContain("digits");
  });

  it("accepts exactly MAX_PBM_PIXELS as a size and fails on the data length instead", () => {
    expect(MAX_PBM_PIXELS).toBe(100_000_000);
    expectCode(() => parsePbmP4(file("P4\n10000 10000\n", 0)), "PBM_DATA_LENGTH");
  });
});

describe("parsePbmP4 data length errors", () => {
  it.each([0, 3, 5, 8])("rejects %i data bytes for 9 x 2", (length) => {
    const e = expectCode(() => parsePbmP4(file("P4\n9 2\n", length)), "PBM_DATA_LENGTH");
    expect(e.message).toContain(String(length));
  });
});

describe("writePbmP4 errors", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects width %s", (width) => {
    expectCode(() => writePbmP4({ width, height: 1, rowBytes: 1, data: new Uint8Array(1) }), "PBM_INVALID_SIZE");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects height %s", (height) => {
    expectCode(() => writePbmP4({ width: 1, height, rowBytes: 1, data: new Uint8Array(1) }), "PBM_INVALID_SIZE");
  });

  it.each([0, 1, 3, 1.5, Number.NaN])("rejects rowBytes %s for width 9", (rowBytes) => {
    const e = expectCode(() => writePbmP4({ width: 9, height: 1, rowBytes, data: new Uint8Array(2) }), "PBM_INVALID_SIZE");
    expect(e.message).toContain("rowBytes");
  });

  it.each([0, 3, 5])("rejects %i data bytes for 9 x 2", (length) => {
    expectCode(() => writePbmP4({ width: 9, height: 2, rowBytes: 2, data: new Uint8Array(length) }), "PBM_DATA_LENGTH");
  });

  it("rejects over-cap sizes before allocating, with empty data", () => {
    const empty = new Uint8Array(0);
    expectCode(() => writePbmP4({ width: MAX_PBM_SIDE + 1, height: 1, rowBytes: 8192, data: empty }), "PBM_TOO_LARGE");
    expectCode(() => writePbmP4({ width: 1, height: MAX_PBM_SIDE + 1, rowBytes: 1, data: empty }), "PBM_TOO_LARGE");
    expectCode(() => writePbmP4({ width: 10_001, height: 10_000, rowBytes: 1251, data: empty }), "PBM_TOO_LARGE");
    expectCode(() => writePbmP4({ width: 2 ** 40, height: 2 ** 40, rowBytes: 1, data: empty }), "PBM_TOO_LARGE");
    expectCode(() => writePbmP4({ width: Number.MAX_SAFE_INTEGER, height: 3, rowBytes: 1, data: empty }), "PBM_TOO_LARGE");
  });

  it("accepts exactly MAX_PBM_PIXELS as a size and fails on the data length instead", () => {
    const empty = new Uint8Array(0);
    expectCode(() => writePbmP4({ width: 10_000, height: 10_000, rowBytes: 1250, data: empty }), "PBM_DATA_LENGTH");
  });
});
