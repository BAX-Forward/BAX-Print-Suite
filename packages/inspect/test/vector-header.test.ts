import { afterEach, describe, expect, it, vi } from "vitest";
import { VECTOR_HEADER_MAX_BYTES, readVectorHeader, type VectorHeaderResult } from "../src/index.js";

/** Spec 035a: header-level facts for SVG and ASCII DXF intake, from tiny fixtures built here. */

// Markup openers are built from the code point so that no literal bang character appears here.
const BANG = String.fromCharCode(0x21);
const DOCTYPE = `<${BANG}DOCTYPE`;
const ENTITY = `<${BANG}ENTITY`;
const COMMENT = `<${BANG}--`;
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
const XLINK_NS = 'xmlns:xlink="http://www.w3.org/1999/xlink"';

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function read(text: string): VectorHeaderResult {
  return readVectorHeader(utf8(text));
}

function pseudoRandomBytes(seed: number, length: number): number[] {
  let state = seed;
  return Array.from({ length }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  });
}

/** Every prefix of a file reads to a result, never an exception. */
function expectPrefixesBounded(bytes: Uint8Array): void {
  for (let length = 0; length <= bytes.length; length += 1) {
    expect(["svg", "dxf", "error"]).toContain(readVectorHeader(bytes.slice(0, length)).kind);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- SVG ---------------------------------------------------------------------------------

describe("readVectorHeader: SVG size", () => {
  it("reads width, height, unit and viewBox from the root element", () => {
    const result = read(`<?xml version="1.0"?>\n<svg ${SVG_NS} width="210mm" height="297mm" viewBox="0 0 210 297"><rect/></svg>`);
    expect(result).toEqual({
      kind: "svg",
      width: 210,
      height: 297,
      unit: "mm",
      viewBox: { minX: 0, minY: 0, width: 210, height: 297 },
      hasDoctype: false,
      hasEntityDecl: false,
      externalRefs: 0,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("reads single-quoted, self-closing and namespace-prefixed roots", () => {
    expect(read(`<svg width='1in' height='2in'/>`)).toMatchObject({ kind: "svg", width: 1, height: 2, unit: "in" });
    expect(read(`<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="10cm" height="5cm">`)).toMatchObject({
      width: 10,
      height: 5,
      unit: "cm",
    });
  });

  it("skips comments, processing instructions and whitespace before the root", () => {
    const text = `\n<?xml version="1.0"?>\n${COMMENT} <svg width="9in"> -->\n<?pi data?>\n<svg width="3pt" height="4pt">`;
    expect(read(text)).toMatchObject({ kind: "svg", width: 3, height: 4, unit: "pt" });
  });

  it("leaves the unit absent for unitless lengths and keeps exponent forms", () => {
    const result = read(`<svg width="100" height="5e1">`);
    expect(result).toMatchObject({ kind: "svg", width: 100, height: 50 });
    expect(result).not.toHaveProperty("unit");
  });

  it("converts mixed absolute units to the width's unit", () => {
    expect(read(`<svg width="1in" height="72pt">`)).toMatchObject({ width: 1, height: 1, unit: "in" });
    expect(read(`<svg width="10mm" height="1cm">`)).toMatchObject({ width: 10, height: 10, unit: "mm" });
  });

  it("drops the unit when relative and absolute units are mixed", () => {
    const result = read(`<svg width="100%" height="50mm">`);
    expect(result).toMatchObject({ width: 100, height: 50 });
    expect(result).not.toHaveProperty("unit");
    expect(read(`<svg width="100%" height="100%">`)).toMatchObject({ unit: "%" });
  });

  it("ignores lengths that are not positive plain lengths", () => {
    const result = read(`<svg width="0" height="-5mm" viewBox="0 0 0 10">`);
    expect(result).toEqual({ kind: "svg", hasDoctype: false, hasEntityDecl: false, externalRefs: 0 });
    expect(read(`<svg width="10furlong" height="calc(1in)">`)).not.toHaveProperty("width");
  });

  it("reads a viewBox separated by commas, with negative origins", () => {
    expect(read(`<svg viewBox="-10,-10 100, 50">`)).toMatchObject({ viewBox: { minX: -10, minY: -10, width: 100, height: 50 } });
  });

  it("keeps the first of duplicated attributes", () => {
    expect(read(`<svg width="1in" width="2in" height="1in">`)).toMatchObject({ width: 1 });
  });
});

describe("readVectorHeader: SVG DTDs and entities", () => {
  it("flags an entity declaration but never expands it into the width", () => {
    const text = [
      `<?xml version="1.0"?>`,
      `${DOCTYPE} svg [`,
      `  ${ENTITY} w "999mm">`,
      `  ${ENTITY} tricky "a > b ] c">`,
      `]>`,
      `<svg ${SVG_NS} width="&w;" height="100mm">`,
    ].join("\n");
    const result = read(text);
    expect(result).toEqual({ kind: "svg", height: 100, unit: "mm", hasDoctype: true, hasEntityDecl: true, externalRefs: 0 });
    expect(JSON.stringify(result)).not.toContain("999");
  });

  it("flags a DOCTYPE with an external DTD without fetching it", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in tests"));
    const dtd = `"-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"`;
    const result = read(`${DOCTYPE} svg PUBLIC ${dtd}>\n<svg width="1in" height="1in">`);
    expect(result).toMatchObject({ kind: "svg", hasDoctype: true, hasEntityDecl: false, externalRefs: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("readVectorHeader: SVG external references", () => {
  it("counts http and file references without fetching them, and skips fragments and data URIs", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in tests"));
    const text = [
      `<svg ${SVG_NS} ${XLINK_NS} width="10mm" height="10mm">`,
      `<image href="http://example.com/photo.png"/>`,
      `<image xlink:href="file:///etc/passwd"/>`,
      `<use href='../shapes/logo.svg#mark'/>`,
      `<use href="#local"/>`,
      `<image xlink:href="data:image/png;base64,AAAA"/>`,
      `<a href=""/>`,
      `<g data-href="http://example.com/not-an-href"/>`,
      `</svg>`,
    ].join("\n");
    expect(read(text)).toMatchObject({ kind: "svg", externalRefs: 3 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("readVectorHeader: SVG prefix bound", () => {
  const root = `<svg ${SVG_NS} width="10mm" height="10mm">`;
  const late = `<image href="http://example.com/late.png"/>${DOCTYPE} svg>${ENTITY} x "y"></svg>`;

  it("ignores references and declarations past the bound", () => {
    const padding = " ".repeat(VECTOR_HEADER_MAX_BYTES);
    expect(read(`${root}${padding}${late}`)).toEqual({
      kind: "svg",
      width: 10,
      height: 10,
      unit: "mm",
      hasDoctype: false,
      hasEntityDecl: false,
      externalRefs: 0,
    });
    expect(read(`${root}${" ".repeat(1024)}${late}`)).toMatchObject({ hasDoctype: true, hasEntityDecl: true, externalRefs: 1 });
  });

  it("reports a root element past the bound as truncated", () => {
    const comment = `${COMMENT} ${"x".repeat(VECTOR_HEADER_MAX_BYTES)} -->`;
    expect(read(`${comment}${root}`)).toMatchObject({ kind: "error", code: "TRUNCATED" });
    expect(read(`${COMMENT} short -->${root}`)).toMatchObject({ kind: "svg", width: 10 });
  });

  it("reports a root start tag that runs past the bound as truncated", () => {
    expect(read(`<svg${" ".repeat(VECTOR_HEADER_MAX_BYTES)} width="1in">`)).toMatchObject({
      kind: "error",
      code: "TRUNCATED",
      format: "svg",
    });
  });
});

describe("readVectorHeader: malformed SVG", () => {
  it("rejects malformed root attributes", () => {
    expect(read(`<svg width=10mm>`)).toMatchObject({ kind: "error", code: "INVALID_HEADER", format: "svg" });
    expect(read(`<svg width="1"height="2">`)).toMatchObject({ kind: "error", code: "INVALID_HEADER", format: "svg" });
    expect(read(`<svg width="1in" height>`)).toMatchObject({ kind: "error", code: "INVALID_HEADER", format: "svg" });
  });

  it("reports an unclosed root start tag at the end of the file as truncated", () => {
    expect(read(`<svg width="1in"`)).toMatchObject({ kind: "error", code: "TRUNCATED", format: "svg" });
  });

  it("does not take other XML roots for SVG", () => {
    expect(read(`<html><body/></html>`)).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
    expect(read(`<svgx width="1in">`)).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
    expect(read(`<${BANG}[CDATA[x]]><svg>`)).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
  });

  it("reads every prefix of an SVG to a result", () => {
    expectPrefixesBounded(utf8(`<?xml version="1.0"?>${DOCTYPE} svg [${ENTITY} a "b">]><svg width="1in" height='2in' viewBox="0 0 1 2"/>`));
  });
});

// ---- DXF ---------------------------------------------------------------------------------

type Pair = readonly [number, string];

function dxfText(pairs: readonly Pair[], eol = "\n"): string {
  return `${pairs.map(([code, value]) => `${String(code).padStart(3)}${eol}${value}`).join(eol)}${eol}`;
}

const HEADER: readonly Pair[] = [
  [0, "SECTION"],
  [2, "HEADER"],
  [9, "$ACADVER"],
  [1, "AC1027"],
  [9, "$INSUNITS"],
  [70, "4"],
  [9, "$EXTMIN"],
  [10, "0.0"],
  [20, "0.0"],
  [30, "0.0"],
  [9, "$EXTMAX"],
  [10, "210.0"],
  [20, "297.0"],
  [30, "0.0"],
  [0, "ENDSEC"],
];

const ENTITIES: readonly Pair[] = [
  [0, "SECTION"],
  [2, "ENTITIES"],
  [9, "$INSUNITS"],
  [70, "1"],
  [9, "$EXTMAX"],
  [10, "1000.0"],
  [20, "1000.0"],
  [0, "LINE"],
  [8, "0"],
  [10, "0.0"],
  [20, "0.0"],
  [11, "210.0"],
  [21, "297.0"],
  [0, "ENDSEC"],
  [0, "EOF"],
];

const EXPECTED_DXF = {
  kind: "dxf",
  acadVer: "AC1027",
  insUnits: 4,
  extMin: { x: 0, y: 0, z: 0 },
  extMax: { x: 210, y: 297, z: 0 },
};

describe("readVectorHeader: DXF HEADER", () => {
  it("reads $ACADVER, $INSUNITS, $EXTMIN and $EXTMAX", () => {
    const result = read(dxfText([...HEADER, [0, "EOF"]]));
    expect(result).toEqual(EXPECTED_DXF);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("ignores everything after the HEADER section, malformed or not", () => {
    expect(read(dxfText([...HEADER, ...ENTITIES]))).toEqual(EXPECTED_DXF);
    expect(read(`${dxfText(HEADER)}not a group code\nvalue\n`)).toEqual(EXPECTED_DXF);
  });

  it("reads CRLF line endings, a leading comment and padded values", () => {
    const pairs: readonly Pair[] = [[999, "written by a test"], ...HEADER.map(([code, value]): Pair => [code, `${value}  `])];
    expect(read(dxfText(pairs, "\r\n"))).toEqual(EXPECTED_DXF);
  });

  it("keeps the first value of a repeated variable and reads 2D points", () => {
    const pairs: readonly Pair[] = [
      [0, "SECTION"],
      [2, "HEADER"],
      [9, "$INSUNITS"],
      [70, "6"],
      [9, "$INSUNITS"],
      [70, "1"],
      [9, "$EXTMIN"],
      [10, "-1.5E+01"],
      [20, "2"],
      [0, "ENDSEC"],
    ];
    expect(read(dxfText(pairs))).toEqual({ kind: "dxf", insUnits: 6, extMin: { x: -15, y: 2 } });
  });

  it("returns no facts when the first section is not HEADER", () => {
    expect(read(dxfText(ENTITIES))).toEqual({ kind: "dxf" });
  });

  it("ignores values that do not parse", () => {
    const pairs: readonly Pair[] = [
      [0, "SECTION"],
      [2, "HEADER"],
      [9, "$INSUNITS"],
      [70, "mm"],
      [9, "$EXTMIN"],
      [10, "x"],
      [20, "0"],
      [0, "ENDSEC"],
    ];
    expect(read(dxfText(pairs))).toEqual({ kind: "dxf" });
  });

  it("stops at the prefix bound inside the HEADER section", () => {
    const start = dxfText([[0, "SECTION"], [2, "HEADER"], [9, "$ACADVER"], [1, "AC1027"], [9, "$MENU"]]);
    const text = `${start}  1\n${"x".repeat(VECTOR_HEADER_MAX_BYTES)}\n${dxfText([[9, "$INSUNITS"], [70, "4"], [0, "ENDSEC"]])}`;
    expect(read(text)).toEqual({ kind: "dxf", acadVer: "AC1027" });
  });

  it("rejects a malformed group code inside the HEADER section", () => {
    const text = `${dxfText([[0, "SECTION"], [2, "HEADER"]])}  X\n$ACADVER\n`;
    expect(read(text)).toMatchObject({ kind: "error", code: "INVALID_HEADER", format: "dxf" });
  });

  it("reads every prefix of a DXF to a result", () => {
    expectPrefixesBounded(utf8(dxfText(HEADER)));
  });
});

describe("readVectorHeader: unsupported and unknown input", () => {
  it("reports binary DXF as unsupported", () => {
    const bytes = Uint8Array.from([...utf8("AutoCAD Binary DXF\r\n"), 0x1a, 0x00, 0x00, 0x00, ...pseudoRandomBytes(7, 64)]);
    expect(readVectorHeader(bytes)).toMatchObject({ kind: "error", code: "UNSUPPORTED", format: "dxf" });
  });

  it("reports empty, raster and text input as unknown", () => {
    expect(readVectorHeader(new Uint8Array(0))).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
    expect(read("GIF89a")).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
    expect(read("%PDF-1.7\n")).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
    expect(read("  0\nLINE\n")).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
  });

  it("reports garbage bytes as unknown, never throwing", () => {
    for (const seed of [1, 2, 3, 42, 1234]) {
      const bytes = Uint8Array.from([0xff, ...pseudoRandomBytes(seed, 4096)]);
      expect(readVectorHeader(bytes)).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
    }
  });

  it("reports a large garbage input as unknown", () => {
    const bytes = new Uint8Array(VECTOR_HEADER_MAX_BYTES * 2).fill(0x41);
    expect(readVectorHeader(bytes)).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
  });
});
