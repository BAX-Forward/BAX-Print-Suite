import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { summarize, type CheckConfig, type PreflightReport } from "@bax-print/plugin-sdk";
import {
  BUILTIN_CHECKS,
  CheckRegistry,
  DEFAULT_PROFILE,
  RASTER_CHECKS,
  builtinRegistry,
  inspectBytes,
  profileToChecks,
  validateProfile,
} from "../src/index.js";

/** Spec 031b: header-only preflight of PNG, JPEG and TIFF inputs, from tiny fixtures built here. */

const NOW = (): Date => new Date("2026-11-05T12:00:00.000Z");

function inspect(bytes: Uint8Array, checks?: Readonly<Record<string, CheckConfig>>): Promise<PreflightReport> {
  return inspectBytes(bytes, { now: NOW, ...(checks === undefined ? {} : { checks }) });
}

/** [checkId, severity, rule] per finding, in report order. */
function outline(report: PreflightReport): [string, string, unknown][] {
  return report.findings.map((finding) => [finding.checkId, finding.severity, finding.data.rule]);
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function u16be(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

// ---- PNG ---------------------------------------------------------------------------------

/** CRCs are left zero: the header reader does not verify them. */
function pngChunk(type: string, data: readonly number[]): number[] {
  return [...u32be(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
}

/** pHYs in pixels per metre: 11811 is 300 dpi, 2835 is 72 dpi. */
function phys(perMetre: number): number[] {
  return pngChunk("pHYs", [...u32be(perMetre), ...u32be(perMetre), 1]);
}

function png(colorType: number, chunks: readonly number[][] = [], bitDepth = 8): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...pngChunk("IHDR", [...u32be(3000), ...u32be(2000), bitDepth, colorType, 0, 0, 0]),
    ...chunks.flat(),
    ...pngChunk("IDAT", []),
    ...pngChunk("IEND", []),
  ]);
}

const PNG_GRAY = 0;
const PNG_RGB = 2;
const PNG_INDEXED = 3;
const PNG_RGBA = 6;

// ---- JPEG --------------------------------------------------------------------------------

function segment(marker: number, data: readonly number[]): number[] {
  return [0xff, marker, ...u16be(data.length + 2), ...data];
}

function jfifDpi(dpi: number): number[] {
  return segment(0xe0, [...ascii("JFIF"), 0, 1, 2, 1, ...u16be(dpi), ...u16be(dpi), 0, 0]);
}

function jpeg(components: number, ...segments: number[][]): Uint8Array {
  const specs = Array.from({ length: components }, (_, index) => [index + 1, 0x11, 0]).flat();
  const frame = segment(0xc0, [8, ...u16be(480), ...u16be(640), components, ...specs]);
  return Uint8Array.from([0xff, 0xd8, ...segments.flat(), ...frame, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
}

// ---- TIFF (little-endian, SHORT values inline) --------------------------------------------

/** Header, one IFD at byte 8 of SHORT fields, then 300/1 X and Y resolution as RATIONALs. */
function tiff(photometric: number, samples: number): Uint8Array {
  const shorts: [number, number][] = [
    [256, 100],
    [257, 50],
    [262, photometric],
    [277, samples],
    [296, 2],
  ];
  const count = shorts.length + 2;
  const rationals = 8 + 2 + count * 12 + 4;
  const view = new DataView(new ArrayBuffer(rationals + 16));
  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, count, true);
  const entry = (index: number, tag: number, type: number, value: number): void => {
    const at = 10 + index * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, 1, true);
    if (type === 3) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
  };
  shorts.forEach(([tag, value], index) => {
    entry(index, tag, 3, value);
  });
  entry(shorts.length, 282, 5, rationals);
  entry(shorts.length + 1, 283, 5, rationals + 8);
  [300, 1, 300, 1].forEach((value, index) => {
    view.setUint32(rationals + index * 4, value, true);
  });
  return new Uint8Array(view.buffer);
}

const TIFF_RGB = 2;
const TIFF_SEPARATED = 5;
const TIFF_LAB = 8;

// ---- Reports -----------------------------------------------------------------------------

describe("raster reports", () => {
  it("reports a PNG from its header: one page, no conformance claims", async () => {
    const report = await inspect(png(PNG_RGB, [phys(11811)]));
    expect(report).toMatchObject({ pageCount: 1, conformance: [], generatedAt: "2026-11-05T12:00:00.000Z" });
    expect(outline(report)).toEqual([["raster-color-mode", "info", "rgb"]]);
    expect(report.findings[0]?.data).toMatchObject({ format: "png", widthPx: 3000, heightPx: 2000, colorMode: "rgb" });
    expect(report.summary).toEqual(summarize(report.findings));
  });

  it("reports a 300 dpi CMYK JPEG with no findings", async () => {
    const report = await inspect(jpeg(4, jfifDpi(300)));
    expect(report).toMatchObject({ pageCount: 1, conformance: [], findings: [] });
  });

  it("reports a 300 dpi RGB TIFF", async () => {
    const report = await inspect(tiff(TIFF_RGB, 3));
    expect(report.pageCount).toBe(1);
    expect(outline(report)).toEqual([["raster-color-mode", "info", "rgb"]]);
  });

  it("carries the profile id", async () => {
    const report = await inspectBytes(tiff(TIFF_SEPARATED, 4), { profileId: "default", now: NOW });
    expect(report).toMatchObject({ profileId: "default", findings: [] });
  });
});

describe("raster-resolution", () => {
  it("warns below the default minimum of 100 dpi", async () => {
    const report = await inspect(png(PNG_GRAY, [phys(2835)]));
    expect(outline(report)).toEqual([["raster-resolution", "warn", "below-minimum"]]);
    expect(report.findings[0]?.data).toMatchObject({ dpiX: 72.01, dpiY: 72.01, thresholdDpi: 100 });
    expect(report.findings[0]?.message).toBe("PNG declares 72.01 × 72.01 dpi, below 100 dpi");
  });

  it("applies a configured minimum", async () => {
    const strict = await inspect(jpeg(1, jfifDpi(300)), { "raster-resolution": { params: { minDpi: 400 } } });
    expect(outline(strict)).toEqual([["raster-resolution", "warn", "below-minimum"]]);
    expect(strict.findings[0]?.data).toMatchObject({ thresholdDpi: 400 });
    const lenient = await inspect(png(PNG_GRAY, [phys(2835)]), { "raster-resolution": { params: { minDpi: 50 } } });
    expect(lenient.findings).toEqual([]);
  });

  it("notes a missing resolution as info, assumed 72 dpi", async () => {
    const report = await inspect(jpeg(1));
    expect(outline(report)).toEqual([["raster-resolution", "info", "missing-resolution"]]);
    expect(report.findings[0]?.data).toMatchObject({ assumedDpi: 72, widthPx: 640, heightPx: 480 });
    expect(report.findings[0]?.message).toContain("225.8 × 169.3 mm");
  });

  it("reports invalid params as an error finding", async () => {
    const report = await inspect(png(PNG_GRAY, [phys(11811)]), { "raster-resolution": { params: { minDpi: -1 } } });
    expect(outline(report)).toEqual([["raster-resolution", "error", "invalid-params"]]);
  });
});

describe("raster-color-mode", () => {
  it("warns for indexed and Lab, and is silent for gray and CMYK", async () => {
    expect(outline(await inspect(png(PNG_INDEXED, [phys(11811)])))).toEqual([["raster-color-mode", "warn", "indexed"]]);
    expect(outline(await inspect(tiff(TIFF_LAB, 3)))).toEqual([["raster-color-mode", "warn", "lab"]]);
    expect((await inspect(png(PNG_GRAY, [phys(11811)]))).findings).toEqual([]);
    expect((await inspect(tiff(TIFF_SEPARATED, 4))).findings).toEqual([]);
  });

  it("warns for an alpha channel or tRNS transparency", async () => {
    expect(outline(await inspect(png(PNG_RGBA, [phys(11811)])))).toEqual([
      ["raster-color-mode", "info", "rgb"],
      ["raster-color-mode", "warn", "alpha"],
    ]);
    expect(outline(await inspect(png(PNG_GRAY, [phys(11811), pngChunk("tRNS", [0, 0])])))).toEqual([
      ["raster-color-mode", "warn", "alpha"],
    ]);
  });
});

describe("raster check configuration", () => {
  it("skips a disabled check and applies severity overrides", async () => {
    const bytes = png(PNG_RGBA, [phys(2835)]);
    const disabled = await inspect(bytes, { "raster-resolution": {}, "raster-color-mode": { enabled: false } });
    expect(outline(disabled)).toEqual([["raster-resolution", "warn", "below-minimum"]]);
    const overridden = await inspect(bytes, { "raster-color-mode": { severity: { rgb: "off", alpha: "error" } } });
    expect(outline(overridden)).toEqual([["raster-color-mode", "error", "alpha"]]);
  });

  it("runs the default profile without findings from the PDF checks", async () => {
    const report = await inspect(png(PNG_RGB, [phys(2835)]), profileToChecks(DEFAULT_PROFILE));
    expect(outline(report)).toEqual([
      ["raster-resolution", "warn", "below-minimum"],
      ["raster-color-mode", "info", "rgb"],
    ]);
  });

  it("warns for an unknown check as for a PDF", async () => {
    const report = await inspect(tiff(TIFF_SEPARATED, 4), { "no-such-check": {} });
    expect(outline(report)).toEqual([["no-such-check", "warn", "unknown-check"]]);
  });

  it("lists the raster checks in the built-in registry and validates their params in profiles", () => {
    expect(builtinRegistry().list().map((check) => check.id)).toEqual(expect.arrayContaining(["raster-resolution", "raster-color-mode"]));
    const profile = { ...DEFAULT_PROFILE, id: "raster", checks: [{ check: "raster-resolution", params: { minDpi: 150 } }] };
    expect(validateProfile(profile).ok).toBe(true);
    expect(validateProfile({ ...profile, checks: [{ check: "raster-resolution", params: { dpi: 150 } }] }).ok).toBe(false);
  });
});

describe("unreadable rasters", () => {
  it("turns a truncated header into one error finding", async () => {
    const report = await inspect(png(PNG_RGB).slice(0, 20));
    expect(report).toMatchObject({ pageCount: 0, conformance: [] });
    expect(outline(report)).toEqual([["document", "error", "unreadable-raster"]]);
    expect(report.findings[0]?.data).toMatchObject({ code: "TRUNCATED" });
  });

  it("turns an invalid header into one error finding", async () => {
    const report = await inspect(png(PNG_RGB, [], 4));
    expect(outline(report)).toEqual([["document", "error", "unreadable-raster"]]);
    expect(report.findings[0]?.data).toMatchObject({ code: "INVALID_HEADER" });
  });

  it("reads input with no raster magic as PDF", async () => {
    const report = await inspect(Uint8Array.from(ascii("GIF89a")));
    expect(outline(report)).toEqual([["document", "error", "unreadable-pdf"]]);
  });
});

describe("PDF inputs", () => {
  it("report exactly as without the raster checks", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    const bytes = await doc.save();
    const rasterIds = new Set(RASTER_CHECKS.map((raster) => raster.check.id));
    const before = new CheckRegistry(BUILTIN_CHECKS.filter((check) => rasterIds.has(check.id) === false));
    const report = await inspect(bytes);
    expect(report.pageCount).toBe(1);
    expect(report.findings.some((finding) => rasterIds.has(finding.checkId))).toBe(false);
    expect(report).toEqual(await inspectBytes(bytes, { now: NOW, registry: before }));
  });
});
