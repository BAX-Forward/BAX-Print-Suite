import { describe, expect, it } from "vitest";
import {
  BitpackError,
  MAX_BITPACK_PIXELS,
  MarkSpecError,
  packPlane1bpp,
  unpackPlane1bpp,
  type BitpackErrorCode,
} from "../src/index.js";

const ROUND_TRIPS = 300;
const SEED = 0x042a;

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

function plane(values: readonly number[]): Uint8Array {
  return Uint8Array.from(values);
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

function expectCode(fn: () => unknown, code: BitpackErrorCode): BitpackError {
  const e = thrown(fn);
  expect(e).toBeInstanceOf(BitpackError);
  expect(e).toBeInstanceOf(MarkSpecError);
  expect(e).toMatchObject({ code });
  if (e instanceof BitpackError) return e;
  throw new Error("expected a BitpackError");
}

describe("packPlane1bpp known bytes", () => {
  it("packs width 8 MSB first with 255 as bit 1", () => {
    const packed = packPlane1bpp({ width: 8, height: 1, plane: plane([255, 0, 255, 0, 0, 0, 0, 255]) });
    expect(packed).toEqual({ width: 8, height: 1, rowBytes: 1, data: plane([0xa1]) });
  });

  it("packs width 9 into two bytes per row", () => {
    const packed = packPlane1bpp({
      width: 9,
      height: 2,
      plane: plane([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 255]),
    });
    expect(packed.rowBytes).toBe(2);
    expect([...packed.data]).toEqual([0xff, 0x80, 0x80, 0x80]);
  });

  it("packs width 1 into one byte per row", () => {
    const packed = packPlane1bpp({ width: 1, height: 3, plane: plane([255, 0, 255]) });
    expect(packed.rowBytes).toBe(1);
    expect([...packed.data]).toEqual([0x80, 0x00, 0x80]);
  });

  it("packs width 16", () => {
    const packed = packPlane1bpp({
      width: 16,
      height: 1,
      plane: plane([255, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 255]),
    });
    expect(packed.rowBytes).toBe(2);
    expect([...packed.data]).toEqual([0xaa, 0x01]);
  });

  it("returns a new plane each time and leaves the input unchanged", () => {
    const input = plane([255, 0, 255]);
    packPlane1bpp({ width: 3, height: 1, plane: input });
    expect([...input]).toEqual([255, 0, 255]);
  });
});

describe("padding bits", () => {
  it("are 0 in the last byte of every row of an all-ink plane", () => {
    for (let width = 1; width <= 17; width++) {
      const height = 3;
      const packed = packPlane1bpp({ width, height, plane: new Uint8Array(width * height).fill(255) });
      const used = width % 8 === 0 ? 8 : width % 8;
      const lastByte = (0xff << (8 - used)) & 0xff;
      for (let y = 0; y < height; y++) {
        const row = [...packed.data.subarray(y * packed.rowBytes, (y + 1) * packed.rowBytes)];
        expect(row).toEqual([...Array.from({ length: packed.rowBytes - 1 }, () => 0xff), lastByte]);
      }
    }
  });

  it("are ignored on unpack", () => {
    const unpacked = unpackPlane1bpp({ width: 3, height: 1, rowBytes: 1, data: plane([0b1011_1111]) });
    expect([...unpacked]).toEqual([255, 0, 255]);
  });
});

describe("round trip", () => {
  it(`unpack(pack(plane)) equals the plane for ${ROUND_TRIPS} seeded random planes`, () => {
    const random = rng(SEED);
    let oddWidths = 0;
    for (let n = 0; n < ROUND_TRIPS; n++) {
      const width = 1 + Math.floor(random() * 40);
      const height = 1 + Math.floor(random() * 12);
      const density = random();
      const input = Uint8Array.from({ length: width * height }, () => (random() < density ? 255 : 0));
      if (width % 8 !== 0) oddWidths++;

      const packed = packPlane1bpp({ width, height, plane: input });
      expect(packed.rowBytes).toBe(Math.ceil(width / 8));
      expect(packed.data.length).toBe(packed.rowBytes * height);
      expect(unpackPlane1bpp(packed)).toEqual(input);
    }
    expect(oddWidths).toBeGreaterThan(ROUND_TRIPS / 2);
  });
});

describe("invalid values", () => {
  it.each([1, 128, 254])("rejects %i and names the first bad index", (bad) => {
    const e = expectCode(() => packPlane1bpp({ width: 5, height: 1, plane: plane([0, 255, bad, 1, bad]) }), "BITPACK_INVALID_VALUE");
    expect(e.message).toContain("plane[2]");
    expect(e.message).toContain(String(bad));
  });
});

describe("size errors", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects width %s", (width) => {
    expectCode(() => packPlane1bpp({ width, height: 1, plane: new Uint8Array(1) }), "BITPACK_INVALID_SIZE");
    expectCode(() => unpackPlane1bpp({ width, height: 1, rowBytes: 1, data: new Uint8Array(1) }), "BITPACK_INVALID_SIZE");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects height %s", (height) => {
    expectCode(() => packPlane1bpp({ width: 1, height, plane: new Uint8Array(1) }), "BITPACK_INVALID_SIZE");
    expectCode(() => unpackPlane1bpp({ width: 1, height, rowBytes: 1, data: new Uint8Array(1) }), "BITPACK_INVALID_SIZE");
  });

  it("rejects a plane whose length is not width * height", () => {
    expectCode(() => packPlane1bpp({ width: 3, height: 2, plane: new Uint8Array(5) }), "BITPACK_INVALID_SIZE");
    expectCode(() => packPlane1bpp({ width: 3, height: 2, plane: new Uint8Array(7) }), "BITPACK_INVALID_SIZE");
  });

  it("rejects a huge size before allocating, with an empty plane", () => {
    const empty = new Uint8Array(0);
    expectCode(() => packPlane1bpp({ width: 100_000, height: 100_000, plane: empty }), "BITPACK_TOO_LARGE");
    expectCode(() => packPlane1bpp({ width: 2 ** 40, height: 2 ** 40, plane: empty }), "BITPACK_TOO_LARGE");
    expectCode(() => packPlane1bpp({ width: Number.MAX_SAFE_INTEGER, height: 3, plane: empty }), "BITPACK_TOO_LARGE");
    expectCode(() => unpackPlane1bpp({ width: 100_000, height: 100_000, rowBytes: 12_500, data: empty }), "BITPACK_TOO_LARGE");
  });

  it("accepts exactly MAX_BITPACK_PIXELS as a size and rejects one more", () => {
    const empty = new Uint8Array(0);
    expect(MAX_BITPACK_PIXELS).toBe(100_000_000);
    // At the limit the size passes and the empty plane fails its length check instead.
    expectCode(() => packPlane1bpp({ width: MAX_BITPACK_PIXELS, height: 1, plane: empty }), "BITPACK_INVALID_SIZE");
    expectCode(() => packPlane1bpp({ width: 10_000, height: 10_000, plane: empty }), "BITPACK_INVALID_SIZE");
    expectCode(() => packPlane1bpp({ width: MAX_BITPACK_PIXELS + 1, height: 1, plane: empty }), "BITPACK_TOO_LARGE");
    expectCode(() => packPlane1bpp({ width: 10_001, height: 10_000, plane: empty }), "BITPACK_TOO_LARGE");
  });
});

describe("unpack layout errors", () => {
  it.each([0, 1, 3, 1.5, Number.NaN])("rejects rowBytes %s for width 9", (rowBytes) => {
    const e = expectCode(() => unpackPlane1bpp({ width: 9, height: 1, rowBytes, data: new Uint8Array(2) }), "BITPACK_INVALID_SIZE");
    expect(e.message).toContain("rowBytes");
  });

  it("rejects data whose length is not rowBytes * height", () => {
    expectCode(() => unpackPlane1bpp({ width: 9, height: 2, rowBytes: 2, data: new Uint8Array(3) }), "BITPACK_INVALID_SIZE");
    expectCode(() => unpackPlane1bpp({ width: 9, height: 2, rowBytes: 2, data: new Uint8Array(5) }), "BITPACK_INVALID_SIZE");
  });
});
