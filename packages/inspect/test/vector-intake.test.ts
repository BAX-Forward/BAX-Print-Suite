import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreflightReport } from "@bax-print/plugin-sdk";
import { VECTOR_CHECKS, inspectBytes, sniffJobSourceFormat, sniffVectorFormat } from "../src/index.js";

/** Spec 035b: jobs taken in as SVG or DXF get their source format from the bytes and run the 035a vector checks. */

const NOW = (): Date => new Date("2026-11-06T12:00:00.000Z");
// Markup openers are built from the code point so that no literal bang character appears here.
const DOCTYPE = `<${String.fromCharCode(0x21)}DOCTYPE`;
const VECTOR_IDS = new Set(VECTOR_CHECKS.map((vector) => vector.check.id));

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const SVG = utf8('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm"/>');
const DXF_NO_HEADER = utf8("  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const BINARY_DXF = Uint8Array.from([...utf8("AutoCAD Binary DXF\r\n"), 0x1a, 0x00, 0x00, 0x00]);

/** [checkId, severity, rule] per finding, in report order. */
function outline(report: PreflightReport): [string, string, unknown][] {
  return report.findings.map((finding) => [finding.checkId, finding.severity, finding.data.rule]);
}

describe("sniffJobSourceFormat", () => {
  it("reads PDF and raster from magic bytes and SVG and DXF from their header", () => {
    expect(sniffJobSourceFormat(utf8("%PDF-1.7\n"))).toBe("pdf");
    expect(sniffJobSourceFormat(PNG)).toBe("png");
    expect(sniffJobSourceFormat(SVG)).toBe("svg");
    expect(sniffJobSourceFormat(DXF_NO_HEADER)).toBe("dxf");
  });

  it("names the format of a recognised but unreadable vector file", () => {
    expect(sniffVectorFormat(BINARY_DXF)).toBe("dxf");
    expect(sniffJobSourceFormat(BINARY_DXF)).toBe("dxf");
  });

  it("returns undefined for bytes that are none of the formats", () => {
    expect(sniffJobSourceFormat(utf8("<html></html>"))).toBeUndefined();
    expect(sniffJobSourceFormat(utf8("hello"))).toBeUndefined();
    expect(sniffJobSourceFormat(new Uint8Array(0))).toBeUndefined();
  });
});

describe("inspectBytes: vector sources", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs only the vector checks on an SVG, as one page without conformance claims", async () => {
    const report = await inspectBytes(SVG, { now: NOW });

    expect(report.pageCount).toBe(1);
    expect(report.conformance).toEqual([]);
    expect(report.findings).toEqual([]);
  });

  it("runs the vector checks on a DXF", async () => {
    const report = await inspectBytes(DXF_NO_HEADER, { now: NOW });

    expect(report.pageCount).toBe(1);
    expect(outline(report)).toEqual([
      ["vector-size", "warn", "missing-units"],
      ["vector-size", "warn", "missing-extents"],
    ]);
  });

  it("reports a DOCTYPE and external references without fetching anything", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no network in preflight")));
    vi.stubGlobal("fetch", fetchSpy);
    const text = `${DOCTYPE} svg SYSTEM "http://127.0.0.1:9/evil.dtd"><svg width="1in" height="1in"><image href="http://127.0.0.1:9/a.png"/></svg>`;

    const report = await inspectBytes(utf8(text), { now: NOW });

    expect(outline(report)).toEqual([
      ["vector-markup", "warn", "doctype"],
      ["vector-markup", "warn", "external-reference"],
    ]);
    expect(report.findings.every((finding) => VECTOR_IDS.has(finding.checkId))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails an unreadable vector file with a fixed error finding", async () => {
    const report = await inspectBytes(BINARY_DXF, { now: NOW });

    expect(report.pageCount).toBe(0);
    expect(outline(report)).toEqual([["document", "error", "unreadable-vector"]]);
    expect(report.findings[0]?.data).toMatchObject({ code: "UNSUPPORTED" });
  });

  it("leaves raster preflight unchanged: no vector check reports on a PNG", async () => {
    const report = await inspectBytes(PNG, { now: NOW });

    expect(report.findings.some((finding) => VECTOR_IDS.has(finding.checkId))).toBe(false);
  });
});
