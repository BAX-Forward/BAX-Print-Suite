import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CutterDriverError, sha256Hex, type CutJob, type Point, type RegistrationMarks } from "@bax-print/plugin-sdk";
import { runCutterDriverConformance, runCutterDriverConformanceProcess } from "@bax-print/plugin-sdk/conformance";
import { makeContour, MM_SCALE_OPERAND, mmToPt, validateCutJob } from "@bax-print/cut-export";
import { createSummaFDriver, REGMARK_LAYER } from "../src/driver.js";
import { buildFProfile, FORMAT_IDS, parseFDeviceConfig } from "../src/profile.js";

const MANIFEST = fileURLToPath(new URL("../bps-plugin.json", import.meta.url));
const TOOLS = [
  { id: "kiss-knife", kind: "kiss", params: { depth: { min: 0, max: 2, unit: "mm" } } },
  { id: "thru-knife", kind: "thru" },
  { id: "crease-wheel", kind: "crease" },
];
const DEVICE = { bedWidthMm: 1600, bedLengthMm: 3200, tools: TOOLS };

const pt = (points: [number, number][]): Point[] => points.map(([x, y]) => [mmToPt(x), mmToPt(y)]);

/** 5 mm camera circles near the corners of a 200 x 100 mm sheet. */
const cameraMarks = (dMm = 5, shape: "circle" | "square" = "circle"): RegistrationMarks => ({
  method: "camera-marks",
  shape,
  originMarkId: "m0",
  marks: [[5, 5], [195, 5], [5, 95], [195, 95]].map(([x, y], i) => ({ id: `m${i}`, xPt: mmToPt(x), yPt: mmToPt(y), dPt: mmToPt(dMm) })),
});

function goldenJob(patch: Partial<CutJob> = {}): CutJob {
  return {
    jobId: "f-golden",
    contours: [
      makeContour({ id: "c1", tool: "kiss", closed: true, points: pt([[20, 20], [60, 20], [60, 50], [20, 50]]) }),
      makeContour({ id: "c2", tool: "thru", closed: true, points: pt([[10, 10], [110, 10], [110, 70], [10, 70]]) }),
      makeContour({ id: "c3", tool: "crease", closed: false, points: pt([[20, 85], [100, 85]]) }),
      // Open, but its ends are 0.3 mm apart: closed like the importer does.
      makeContour({ id: "c4", tool: "kiss", closed: false, points: pt([[130, 20], [170, 20], [170, 60], [130.3, 20]]) }),
    ],
    toolMap: { kiss: { toolId: "kiss-knife" }, thru: { toolId: "thru-knife" }, crease: { toolId: "crease-wheel" } },
    frame: { widthPt: mmToPt(200), heightPt: mmToPt(100) },
    marks: cameraMarks(),
    options: {},
    ...patch,
  };
}

const CM = `${MM_SCALE_OPERAND} 0 0 ${MM_SCALE_OPERAND} 0 0 cm`;
const STROKE = ["q", CM, "0.1 w", "0 0 0 RG"];

const GOLDEN_CONTENT = [
  "/OC /L0 BDC",
  ...STROKE,
  "20 20 m", "60 20 l", "60 50 l", "20 50 l", "h", "S",
  "130 20 m", "170 20 l", "170 60 l", "130.3 20 l", "h", "S",
  "Q",
  "EMC",
  "/OC /L1 BDC",
  ...STROKE,
  "10 10 m", "110 10 l", "110 70 l", "10 70 l", "h", "S",
  "Q",
  "EMC",
  "/OC /L2 BDC",
  ...STROKE,
  "20 85 m", "100 85 l", "S",
  "Q",
  "EMC",
  "/OC /L3 BDC",
  "q",
  CM,
  "0 0 0 1 k",
  "7.5 5 m",
  "7.5 6.3807 6.3807 7.5 5 7.5 c",
  "3.6193 7.5 2.5 6.3807 2.5 5 c",
  "2.5 3.6193 3.6193 2.5 5 2.5 c",
  "6.3807 2.5 7.5 3.6193 7.5 5 c",
  "h",
  "f",
  "197.5 5 m",
  "197.5 6.3807 196.3807 7.5 195 7.5 c",
  "193.6193 7.5 192.5 6.3807 192.5 5 c",
  "192.5 3.6193 193.6193 2.5 195 2.5 c",
  "196.3807 2.5 197.5 3.6193 197.5 5 c",
  "h",
  "f",
  "7.5 95 m",
  "7.5 96.3807 6.3807 97.5 5 97.5 c",
  "3.6193 97.5 2.5 96.3807 2.5 95 c",
  "2.5 93.6193 3.6193 92.5 5 92.5 c",
  "6.3807 92.5 7.5 93.6193 7.5 95 c",
  "h",
  "f",
  "197.5 95 m",
  "197.5 96.3807 196.3807 97.5 195 97.5 c",
  "193.6193 97.5 192.5 96.3807 192.5 95 c",
  "192.5 93.6193 193.6193 92.5 195 92.5 c",
  "196.3807 92.5 197.5 93.6193 197.5 95 c",
  "h",
  "f",
  "Q",
  "EMC",
  "",
].join("\n");

interface PdfInspection {
  content: string;
  /** Property name (L0, L1, ...) -> OCG name. */
  layers: Record<string, string>;
  ocgCount: number;
  resourceKeys: string[];
  pageCount: number;
}

async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const stream = doc.context.lookup(page.node.get(PDFName.of("Contents")));
  if (!(stream instanceof PDFRawStream)) throw new Error("expected a single raw content stream");
  const content = new TextDecoder().decode(stream.getContents());
  const resources = page.node.Resources();
  const properties = resources?.lookup(PDFName.of("Properties"), PDFDict);
  const layers: Record<string, string> = {};
  for (const [, id] of content.matchAll(/\/OC \/(\w+) BDC/g)) {
    const name = properties?.lookup(PDFName.of(id), PDFDict).lookup(PDFName.of("Name"));
    if (!(name instanceof PDFString || name instanceof PDFHexString)) throw new Error(`OCG ${id} has no name`);
    layers[id] = name.decodeText();
  }
  const ocProperties = doc.catalog.lookup(PDFName.of("OCProperties"), PDFDict);
  return {
    content,
    layers,
    ocgCount: ocProperties.lookup(PDFName.of("OCGs"), PDFArray).size(),
    resourceKeys: resources ? resources.keys().map((k) => k.asString()) : [],
    pageCount: doc.getPageCount(),
  };
}

/** Lines of the marked-content block for one property name, without BDC and EMC. */
function layerBlock(content: string, id: string): string[] {
  const lines = content.split("\n");
  const start = lines.indexOf(`/OC /${id} BDC`);
  if (start < 0) throw new Error(`no block for ${id}`);
  return lines.slice(start + 1, lines.indexOf("EMC", start));
}

/** Circle sizes (mm) from `m ... c ... h f` subpaths: extent of all on-curve and control points. */
function circleDiametersMm(block: string[]): { dx: number; dy: number }[] {
  const circles: { dx: number; dy: number }[] = [];
  let coords: number[] = [];
  for (const line of block) {
    if (line.endsWith(" m")) coords = [];
    if (line.endsWith(" m") || line.endsWith(" c")) coords.push(...line.split(" ").slice(0, -1).map(Number));
    if (line === "f") {
      const xs = coords.filter((_, i) => i % 2 === 0);
      const ys = coords.filter((_, i) => i % 2 === 1);
      circles.push({ dx: Math.max(...xs) - Math.min(...xs), dy: Math.max(...ys) - Math.min(...ys) });
    }
  }
  return circles;
}

/** Lines that would paint or set state outside any `/OC ... BDC` / `EMC` block. */
function linesOutsideLayers(content: string): string[] {
  let depth = 0;
  const outside: string[] = [];
  for (const line of content.split("\n").filter((l) => l.length > 0)) {
    if (line.endsWith(" BDC")) depth++;
    else if (line === "EMC") depth--;
    else if (depth === 0) outside.push(line);
  }
  return outside;
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function errorCode(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    return error instanceof CutterDriverError ? error.code : `not a CutterDriverError: ${String(error)}`;
  }
  return undefined;
}

describe("cutter-summa-f conformance", () => {
  it("passes the CutterDriver/2 kit in-process", async () => {
    const report = await runCutterDriverConformance(createSummaFDriver(), { deviceConfig: DEVICE });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("passes the kit as a separate process over BPP, with spooled artifacts", async () => {
    const report = await runCutterDriverConformanceProcess(MANIFEST, { deviceConfig: DEVICE });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.passed).toBe(true);
  });
});

describe("cutter-summa-f PDF cut file", () => {
  it("matches the golden content stream, with layers named per toolMap and the Regmark layer last", async () => {
    const result = await createSummaFDriver().export(goldenJob(), FORMAT_IDS.pdfCut);
    expect(result.fileName).toBe("f-golden.pdf");
    expect(result.mime).toBe("application/pdf");
    expect(result.sha256).toBe(sha256Hex(result.bytes));
    expect(result.warnings).toEqual(["closed 1 open path(s) within 0.5 mm: c4"]);

    const pdf = await inspectPdf(result.bytes);
    expect(pdf.content).toBe(GOLDEN_CONTENT);
    expect(pdf.layers).toEqual({ L0: "Kiss-cut", L1: "Thru-cut", L2: "Crease", L3: REGMARK_LAYER });
    expect(pdf.ocgCount).toBe(4);
  });

  it("has 4 circles of 5 mm +-0.01 on the Regmark layer", async () => {
    const pdf = await inspectPdf((await createSummaFDriver().export(goldenJob(), FORMAT_IDS.pdfCut)).bytes);
    const circles = circleDiametersMm(layerBlock(pdf.content, "L3"));
    expect(circles).toHaveLength(4);
    for (const { dx, dy } of circles) {
      expect(Math.abs(dx - 5)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(dy - 5)).toBeLessThanOrEqual(0.01);
    }
  });

  it("has no content outside the cut and mark layers (no print data)", async () => {
    const pdf = await inspectPdf((await createSummaFDriver().export(goldenJob(), FORMAT_IDS.pdfCut)).bytes);
    expect(pdf.pageCount).toBe(1);
    expect(linesOutsideLayers(pdf.content)).toEqual([]);
    // Only optional-content properties: no images, fonts, forms or graphics states.
    expect(pdf.resourceKeys).toEqual(["/Properties"]);
  });

  it("is deterministic", async () => {
    const driver = createSummaFDriver();
    const a = await driver.export(goldenJob(), FORMAT_IDS.pdfCut);
    const b = await driver.export(goldenJob(), FORMAT_IDS.pdfCut);
    expect(a.sha256).toBe(b.sha256);
  });

  it("uses user layer names, by tool id first and then by semantic tool", async () => {
    const options = { layerNames: { "thru-knife": "Through", thru: "ignored", crease: "Score" }, regmarkLayerName: "Marks" };
    const pdf = await inspectPdf((await createSummaFDriver().export(goldenJob({ options }), FORMAT_IDS.pdfCut)).bytes);
    expect(Object.values(pdf.layers)).toEqual(["Kiss-cut", "Through", "Score", "Marks"]);
  });

  it("rejects a cut layer that collides with the mark layer", async () => {
    const job = goldenJob({ options: { layerNames: { kiss: REGMARK_LAYER } } });
    expect(await errorCode(() => createSummaFDriver().export(job, FORMAT_IDS.pdfCut))).toBe("invalid-options");
  });

  it("omits the mark layer without marks", async () => {
    const pdf = await inspectPdf((await createSummaFDriver().export(goldenJob({ marks: undefined }), FORMAT_IDS.pdfCut)).bytes);
    expect(Object.values(pdf.layers)).toEqual(["Kiss-cut", "Thru-cut", "Crease"]);
  });

  it("keeps open paths with a gap above the close tolerance open", async () => {
    const result = await createSummaFDriver().export(goldenJob({ options: { closeToleranceMm: 0.2 } }), FORMAT_IDS.pdfCut);
    expect(result.warnings).toEqual([]);
    const kiss = layerBlock((await inspectPdf(result.bytes)).content, "L0");
    expect(kiss.slice(-4)).toEqual(["170 60 l", "130.3 20 l", "S", "Q"]);
  });

  it("warns about marks that are not the size the importer looks for", async () => {
    const result = await createSummaFDriver().export(goldenJob({ marks: cameraMarks(3) }), FORMAT_IDS.pdfCut);
    expect(result.warnings).toContain("mark m0: 3.00 mm, the importer looks for 5 mm circles");
  });
});

describe("cutter-summa-f DXF", () => {
  it("writes R12 with one layer per method, Regmark circles relative to the origin mark and optional labels", async () => {
    const result = await createSummaFDriver().export(goldenJob({ options: { labels: true } }), FORMAT_IDS.dxf);
    expect(result.fileName).toBe("f-golden.dxf");
    const text = decode(result.bytes);
    expect(text).toContain("9\r\n$ACADVER\r\n1\r\nAC1009\r\n");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");

    const layers = [...text.matchAll(/0\r\nLAYER\r\n2\r\n([^\r]+)\r\n/g)].map((m) => m[1]);
    expect(layers).toEqual(["Kiss-cut", "Thru-cut", "Crease", REGMARK_LAYER]);

    const flags = [...text.matchAll(/0\r\nPOLYLINE\r\n8\r\n[^\r]+\r\n66\r\n1\r\n10\r\n0\.0000\r\n20\r\n0\.0000\r\n30\r\n0\.0000\r\n70\r\n(\d)\r\n/g)].map((m) => m[1]);
    expect(flags).toEqual(["1", "1", "0", "1"]);
    expect(text.match(/0\r\nTEXT\r\n/g)).toHaveLength(4);

    const circles = [...text.matchAll(/0\r\nCIRCLE\r\n8\r\n([^\r]+)\r\n10\r\n([^\r]+)\r\n20\r\n([^\r]+)\r\n30\r\n[^\r]+\r\n40\r\n([^\r]+)\r\n/g)];
    expect(circles.map((m) => [m[1], m[2], m[3], m[4]])).toEqual([
      [REGMARK_LAYER, "0.0000", "0.0000", "2.5000"],
      [REGMARK_LAYER, "190.0000", "0.0000", "2.5000"],
      [REGMARK_LAYER, "0.0000", "90.0000", "2.5000"],
      [REGMARK_LAYER, "190.0000", "90.0000", "2.5000"],
    ]);
  });

  it("labels nothing by default", async () => {
    const text = decode((await createSummaFDriver().export(goldenJob(), FORMAT_IDS.dxf)).bytes);
    expect(text).not.toContain("\r\nTEXT\r\n");
  });
});

describe("cutter-summa-f barcode job id (experimental)", () => {
  it('returns "experimental-disabled" unless enabled, and names the file after a valid id', async () => {
    const driver = createSummaFDriver();
    expect(await errorCode(() => driver.export(goldenJob({ options: { barcodeJobId: "JOB-12345" } }), FORMAT_IDS.pdfCut))).toBe(
      "experimental-disabled",
    );
    const enabled = await driver.export(goldenJob({ options: { barcodeJobId: "JOB-12345", enableExperimentalBarcode: true } }), FORMAT_IDS.pdfCut);
    expect(enabled.fileName).toBe("JOB-12345.pdf");
  });

  it.each(["SHORT", "WAY-TOO-LONG-ID", "lower12345", "JOB 12345"])('rejects the id "%s" (8-13 Code 39 characters)', async (id) => {
    const job = goldenJob({ options: { barcodeJobId: id, enableExperimentalBarcode: true } });
    expect(await errorCode(() => createSummaFDriver().export(job, FORMAT_IDS.dxf))).toBe("invalid-options");
  });
});

describe("cutter-summa-f profile and validation", () => {
  it("declares a flatbed profile from user-entered device configuration", () => {
    const profile = buildFProfile(parseFDeviceConfig({ ...DEVICE, bedOrigin: "top-left", vacuumZones: 4, toolSlots: 3 }));
    expect(profile.class).toBe("flatbed");
    expect(profile.workArea).toEqual({ widthMm: 1600, lengthMm: 3200 });
    expect(profile.flatbed).toEqual({ bedOrigin: "top-left", conveyor: false, vacuumZones: 4 });
    expect(profile.toolSlots).toBe(3);
    expect(profile.tools.map((t) => [t.id, t.kind])).toEqual([
      ["kiss-knife", "kiss"],
      ["thru-knife", "thru"],
      ["crease-wheel", "crease"],
    ]);
    expect(profile.registration).toEqual({
      methods: ["camera-marks", "none"],
      markShapes: ["circle"],
      markSizeMm: { min: 5, max: 5, unit: "mm" },
      barcodeJobId: { supported: false, documented: false },
    });
    expect(profile.delivery).toEqual(["folder-import"]);
    expect(profile.formats).toEqual(["pdf-cut", "dxf"]);
  });

  it("accepts the golden job", () => {
    const report = validateCutJob(goldenJob(), buildFProfile(parseFDeviceConfig(DEVICE)));
    expect(report.errors).toEqual([]);
  });

  /** A 3.5 m thru-cut, longer than the 3.2 m bed. */
  const longContours = () => [...goldenJob().contours, makeContour({ id: "long", tool: "thru", closed: false, points: pt([[10, 10], [10, 3500]]) })];

  const rejected: [name: string, patch: Partial<CutJob>, codes: string[]][] = [
    ["a job longer than the bed without a conveyor", { contours: longContours() }, ["extent-length"]],
    ["square marks", { marks: cameraMarks(5, "square") }, ["mark-shape-unsupported"]],
    // Core validation reports the size of each of the 4 marks separately.
    ["3 mm marks", { marks: cameraMarks(3) }, Array(4).fill("mark-size-out-of-range")],
    ["an out-of-range depth", { toolMap: { ...goldenJob().toolMap, kiss: { toolId: "kiss-knife", depth: 3 } } }, ["param-out-of-range"]],
    ["an uninstalled tool", { toolMap: { ...goldenJob().toolMap, crease: { toolId: "router" } } }, ["unknown-tool"]],
  ];

  it.each(rejected)("makes core validation reject %s", (_name, patch, codes) => {
    const report = validateCutJob(goldenJob(patch), buildFProfile(parseFDeviceConfig(DEVICE)));
    expect(report.errors.map((e) => e.code)).toEqual(codes);
  });

  it("allows jobs longer than the bed when the machine has a conveyor", () => {
    const report = validateCutJob(goldenJob({ contours: longContours() }), buildFProfile(parseFDeviceConfig({ ...DEVICE, conveyor: true })));
    expect(report.errors).toEqual([]);
  });

  it.each([
    [{ bedLengthMm: 3200, tools: TOOLS }, "bedWidthMm"],
    [{ ...DEVICE, tools: [] }, "tools"],
    [{ ...DEVICE, tools: [{ id: "x", kind: "laser" }] }, "tools[0].kind"],
    [{ ...DEVICE, tools: [TOOLS[0], TOOLS[0]] }, "duplicate tool id"],
    [{ ...DEVICE, bedOrigin: "center" }, "bedOrigin"],
    [{ ...DEVICE, delivery: { method: "tcp" } }, "delivery.method"],
    [{ ...DEVICE, delivery: { method: "folder-import", folder: "x", format: "svg" } }, "delivery.format"],
  ])("rejects invalid device config %j", (config, message) => {
    try {
      parseFDeviceConfig(config);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CutterDriverError);
      expect((error as CutterDriverError).code).toBe("invalid-device-config");
      expect((error as Error).message).toContain(message);
    }
  });
});

describe("cutter-summa-f folder delivery", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bps-f-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("drops the PDF cut file into the import folder", async () => {
    const driver = createSummaFDriver();
    const result = await driver.send?.(goldenJob(), { ...DEVICE, delivery: { method: "folder-import", folder: dir } });
    expect(result?.status).toBe("delivered");
    expect(result?.detail?.startsWith(join(dir, "f-golden.pdf"))).toBe(true);
    const written = new Uint8Array(await readFile(join(dir, "f-golden.pdf")));
    expect(sha256Hex(written)).toBe((await driver.export(goldenJob(), FORMAT_IDS.pdfCut)).sha256);
  });

  it("drops DXF when configured, named after the barcode id when barcodes are enabled", async () => {
    const config = { ...DEVICE, enableExperimentalBarcode: true, delivery: { method: "folder-import", folder: dir, format: "dxf" } };
    const result = await createSummaFDriver().send?.(goldenJob({ options: { barcodeJobId: "JOB-12345" } }), config);
    expect(result?.status).toBe("delivered");
    expect(decode(new Uint8Array(await readFile(join(dir, "JOB-12345.dxf"))))).toContain("AC1009");
  });

  it("fails without an import folder and rejects invalid jobs before writing", async () => {
    const driver = createSummaFDriver();
    expect((await driver.send?.(goldenJob(), DEVICE))?.status).toBe("failed");
    const bad = goldenJob({ toolMap: { ...goldenJob().toolMap, kiss: { toolId: "missing" } } });
    expect(await errorCode(() => driver.send?.(bad, { ...DEVICE, delivery: { method: "folder-import", folder: dir } }))).toBe("invalid-job");
  });

  it("reports the import folder state, not the machine state", async () => {
    const driver = createSummaFDriver();
    expect((await driver.getStatus?.(DEVICE))?.state).toBe("unknown");
    expect((await driver.getStatus?.({ ...DEVICE, delivery: { method: "folder-import", folder: dir } }))?.state).toBe("ready");
    const missing = { ...DEVICE, delivery: { method: "folder-import", folder: join(dir, "missing") } };
    expect((await driver.getStatus?.(missing))?.state).toBe("offline");
  });
});
