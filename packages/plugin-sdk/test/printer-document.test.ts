import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";
import {
  acceptsDocuments,
  Connection,
  documentByteLimit,
  DocumentErrorCodes,
  ErrorCodes,
  MAX_DOCUMENT_BYTES,
  PluginServer,
  PrinterDriverMethods,
  readFileDocument,
  registerPrinterDriver,
  runPrinterDriverConformance,
  silentLogger,
  SUBMIT_DOCUMENT_PARAMS_SCHEMA,
  validateSchema,
  writeFileBand,
  type FileBandHandle,
  type PrinterCapabilities,
  type PrinterDriverV1,
  type SubmitDocumentParams,
} from "../src/bpp/index.js";

const PDF = new TextEncoder().encode("%PDF-1.4\n% sdk document test\n%%EOF\n");
const DEVICE_ID = "doc-1";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bpp-document-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const BAND_CAPABILITIES: PrinterCapabilities = {
  input: "bands",
  colorants: ["K"],
  bitsPerSample: [8],
  resolutionsDpi: [[72, 72]],
};

/** The band-only driver of the existing conformance tests: no documentFormats, no submitDocument. */
function bandDriver(): PrinterDriverV1 {
  return {
    discover: async () => ({ devices: [{ deviceId: "d1", name: "Lax", capabilities: BAND_CAPABILITIES }] }),
    getStatus: async ({ deviceId }) => ({ deviceId, state: "idle" }),
    listMedia: async () => ({ media: [] }),
    submit: async () => ({ accepted: true }),
    onBand: async () => undefined,
    complete: async ({ submissionId }) => ({ submissionId, state: "printed", bandsReceived: 0, bytesReceived: 0 }),
    cancel: async () => undefined,
    accounting: async () => ({ records: [] }),
  };
}

interface Received {
  params: SubmitDocumentParams;
  bytes: Uint8Array;
}

/** A document-input driver; `submitDocument` is left out when `implement` is false. */
function documentDriver(
  capabilities: Partial<PrinterCapabilities> = {},
  received: Received[] = [],
  implement = true,
): PrinterDriverV1 {
  const caps: PrinterCapabilities = {
    input: "document",
    colorants: [],
    bitsPerSample: [],
    resolutionsDpi: [],
    documentFormats: ["pdf"],
    ...capabilities,
  };
  const known = (deviceId: string): void => {
    if (deviceId !== DEVICE_ID) throw new sdk.RpcError(ErrorCodes.InvalidParams, `unknown device ${deviceId}`);
  };
  const driver: PrinterDriverV1 = {
    discover: async () => ({ devices: [{ deviceId: DEVICE_ID, name: "Document device", capabilities: caps }] }),
    getStatus: async ({ deviceId }) => {
      known(deviceId);
      return { deviceId, state: "idle" };
    },
    listMedia: async ({ deviceId }) => {
      known(deviceId);
      return { media: [] };
    },
    submit: async () => ({ accepted: false, reason: "documents only" }),
    onBand: async () => {
      throw new Error("documents only");
    },
    complete: async ({ submissionId }) => {
      throw new Error(`unknown submission ${submissionId}`);
    },
    cancel: async () => undefined,
    accounting: async () => ({ records: [] }),
  };
  if (implement === false) return driver;
  return {
    ...driver,
    submitDocument: async (params, bytes) => {
      received.push({ params, bytes });
      return { submissionId: params.submissionId };
    },
  };
}

/** Serves `driver` over an in-memory BPP connection and initializes it with `spoolDir`. */
async function serve(driver: PrinterDriverV1, spoolDir: string): Promise<{ host: Connection; close: () => void }> {
  const hostToPlugin = new PassThrough();
  const pluginToHost = new PassThrough();
  const server = new PluginServer({
    plugin: { id: "org.example.document", name: "Document test", version: "0.0.1" },
    offers: [{ interface: "PrinterDriver", version: "1.0.0" }],
    input: hostToPlugin,
    output: pluginToHost,
    log: silentLogger,
  });
  registerPrinterDriver(server, driver);
  const host = new Connection(pluginToHost, hostToPlugin);
  await host.request("initialize", {
    protocol: sdk.BPP_PROTOCOL,
    host: { name: "test-host", version: "0.0.0" },
    interfaces: [{ interface: "PrinterDriver", versions: ">=1.0 <2" }],
    spoolDir,
    capabilities: { transports: ["file"] },
  });
  return {
    host,
    close: () => {
      host.close();
      server.connection.close();
    },
  };
}

function documentParams(document: FileBandHandle, overrides: Partial<SubmitDocumentParams> = {}): SubmitDocumentParams {
  return {
    deviceId: DEVICE_ID,
    jobId: "job-1",
    submissionId: "sub-1",
    format: "pdf",
    byteLength: PDF.byteLength,
    sha256: sha256Hex(PDF),
    document,
    ...overrides,
  };
}

const HANDLE: FileBandHandle = { transport: "file", path: "/spool/job-1.pdf", sizeBytes: PDF.byteLength };

describe("printer/submitDocument params schema", () => {
  it("accepts a well-formed request with and without the optional fields", () => {
    expect(validateSchema(SUBMIT_DOCUMENT_PARAMS_SCHEMA, documentParams(HANDLE))).toEqual([]);
    expect(
      validateSchema(SUBMIT_DOCUMENT_PARAMS_SCHEMA, documentParams(HANDLE, { copies: 999, mediaName: "Matte", sha256: "A".repeat(64) })),
    ).toEqual([]);
  });

  const valid = documentParams(HANDLE);
  const withoutDocument = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "document"));
  it.each<[string, unknown]>([
    ["a missing document handle", withoutDocument],
    ["bytes inline instead of a file handle", { ...valid, document: { transport: "inline", data: "JVBERg==" } }],
    ["an unsupported format", { ...valid, format: "jpeg" }],
    ["a zero byteLength", { ...valid, byteLength: 0 }],
    ["a fractional byteLength", { ...valid, byteLength: 1.5 }],
    ["a short sha256", { ...valid, sha256: "ab" }],
    ["a non-hex sha256", { ...valid, sha256: "z".repeat(64) }],
    ["zero copies", { ...valid, copies: 0 }],
    ["too many copies", { ...valid, copies: 1000 }],
    ["an empty mediaName", { ...valid, mediaName: "" }],
    ["an empty submissionId", { ...valid, submissionId: "" }],
  ])("rejects %s", (_label, params) => {
    expect(validateSchema(SUBMIT_DOCUMENT_PARAMS_SCHEMA, params).length).toBeGreaterThan(0);
  });
});

describe("document capabilities and limits", () => {
  it("detects document input only from a non-empty documentFormats", () => {
    expect(acceptsDocuments(BAND_CAPABILITIES)).toBe(false);
    expect(acceptsDocuments({ ...BAND_CAPABILITIES, documentFormats: [] })).toBe(false);
    expect(acceptsDocuments({ ...BAND_CAPABILITIES, input: "document" })).toBe(false);
    expect(acceptsDocuments({ ...BAND_CAPABILITIES, documentFormats: ["tiff"] })).toBe(true);
  });

  it("caps the advertised limit at MAX_DOCUMENT_BYTES (1 GiB)", () => {
    expect(MAX_DOCUMENT_BYTES).toBe(1024 ** 3);
    expect(documentByteLimit(BAND_CAPABILITIES)).toBe(MAX_DOCUMENT_BYTES);
    expect(documentByteLimit({ ...BAND_CAPABILITIES, maxDocumentBytes: 4096 })).toBe(4096);
    expect(documentByteLimit({ ...BAND_CAPABILITIES, maxDocumentBytes: 2 * MAX_DOCUMENT_BYTES })).toBe(MAX_DOCUMENT_BYTES);
    expect(documentByteLimit({ ...BAND_CAPABILITIES, maxDocumentBytes: 0 })).toBe(MAX_DOCUMENT_BYTES);
  });

  it("exports the document names explicitly from the package entry point", () => {
    expect(sdk.MAX_DOCUMENT_BYTES).toBe(MAX_DOCUMENT_BYTES);
    expect(sdk.PrinterDriverMethods.submitDocument).toBe("printer/submitDocument");
    expect(sdk.DocumentErrorCodes).toEqual({
      tooLarge: "DOCUMENT_TOO_LARGE",
      mismatch: "DOCUMENT_MISMATCH",
      formatNotAccepted: "FORMAT_NOT_ACCEPTED",
    });
    expect(typeof sdk.readFileDocument).toBe("function");
    expect(typeof sdk.acceptsDocuments).toBe("function");
    expect(sdk.SUBMIT_DOCUMENT_PARAMS_SCHEMA).toBe(SUBMIT_DOCUMENT_PARAMS_SCHEMA);
  });
});

describe("readFileDocument", () => {
  it("reads a spool file and checks size and sha256 case-insensitively", async () => {
    const spool = await tempDir();
    const outside = await tempDir();
    const handle = await writeFileBand(spool, "docs/a.pdf", PDF);
    const expected = { byteLength: PDF.byteLength, sha256: sha256Hex(PDF).toUpperCase() };
    expect(new Uint8Array(await readFileDocument(handle, spool, expected))).toEqual(PDF);
    await expect(readFileDocument(handle, spool, { ...expected, byteLength: PDF.byteLength + 1 })).rejects.toMatchObject({
      data: { code: DocumentErrorCodes.mismatch },
    });
    await expect(readFileDocument(handle, spool, { ...expected, sha256: "0".repeat(64) })).rejects.toMatchObject({
      data: { code: DocumentErrorCodes.mismatch },
    });
    const foreign = await writeFileBand(outside, "a.pdf", PDF);
    await expect(readFileDocument(foreign, spool, expected)).rejects.toThrow(/outside the spool/);
  });
});

describe("registerPrinterDriver and printer/submitDocument", () => {
  it("does not register printer/submitDocument for a band-only driver", async () => {
    const spool = await tempDir();
    const { host, close } = await serve(bandDriver(), spool);
    try {
      const handle = await writeFileBand(spool, "a.pdf", PDF);
      await expect(host.request(PrinterDriverMethods.submitDocument, documentParams(handle))).rejects.toMatchObject({
        code: ErrorCodes.MethodNotFound,
      });
      await expect(host.request(PrinterDriverMethods.discover)).resolves.toEqual({
        devices: [{ deviceId: "d1", name: "Lax", capabilities: BAND_CAPABILITIES }],
      });
    } finally {
      close();
    }
  });

  it("does not register it when a document device leaves submitDocument out", async () => {
    const spool = await tempDir();
    const { host, close } = await serve(documentDriver({}, [], false), spool);
    try {
      const handle = await writeFileBand(spool, "a.pdf", PDF);
      await expect(host.request(PrinterDriverMethods.submitDocument, documentParams(handle))).rejects.toMatchObject({
        code: ErrorCodes.MethodNotFound,
      });
    } finally {
      close();
    }
  });

  it("hands the checked bytes and params to the driver", async () => {
    const spool = await tempDir();
    const received: Received[] = [];
    const { host, close } = await serve(documentDriver({}, received), spool);
    try {
      const handle = await writeFileBand(spool, "jobs/a.pdf", PDF);
      const params = documentParams(handle, { copies: 3, mediaName: "Gloss" });
      await expect(host.request(PrinterDriverMethods.submitDocument, params)).resolves.toEqual({ submissionId: "sub-1" });
      expect(received).toHaveLength(1);
      expect(received[0]?.params).toEqual(params);
      expect(new Uint8Array(received[0]?.bytes ?? [])).toEqual(PDF);
    } finally {
      close();
    }
  });

  it("refuses invalid params, unknown devices, formats, oversized and mismatched documents", async () => {
    const spool = await tempDir();
    const received: Received[] = [];
    const { host, close } = await serve(documentDriver({ maxDocumentBytes: 64 }, received), spool);
    const submit = (params: unknown): Promise<unknown> => host.request(PrinterDriverMethods.submitDocument, params);
    const refusedWith = (code: string): { code: number; data: { code: string } } => ({ code: ErrorCodes.InvalidParams, data: { code } });
    try {
      const handle = await writeFileBand(spool, "jobs/a.pdf", PDF);
      await expect(submit({ ...documentParams(handle), byteLength: 0 })).rejects.toMatchObject({
        code: ErrorCodes.InvalidParams,
        data: { errors: expect.any(Array) },
      });
      await expect(submit(documentParams(handle, { deviceId: "other" }))).rejects.toMatchObject({
        code: ErrorCodes.InvalidParams,
      });
      await expect(submit(documentParams(handle, { format: "tiff" }))).rejects.toMatchObject(
        refusedWith(DocumentErrorCodes.formatNotAccepted),
      );
      // The limit is checked before the file is touched: this path does not exist.
      const missing: FileBandHandle = { transport: "file", path: join(spool, "missing.pdf"), sizeBytes: 65 };
      await expect(submit(documentParams(missing, { byteLength: 65 }))).rejects.toMatchObject(
        refusedWith(DocumentErrorCodes.tooLarge),
      );
      await expect(
        submit(documentParams(handle, { byteLength: PDF.byteLength - 1, document: { ...handle, sizeBytes: PDF.byteLength - 1 } })),
      ).rejects.toMatchObject(refusedWith(DocumentErrorCodes.mismatch));
      await expect(submit(documentParams(handle, { byteLength: PDF.byteLength - 1 }))).rejects.toMatchObject(
        refusedWith(DocumentErrorCodes.mismatch),
      );
      await expect(submit(documentParams(handle, { sha256: "0".repeat(64) }))).rejects.toMatchObject(
        refusedWith(DocumentErrorCodes.mismatch),
      );
      expect(received).toEqual([]);
    } finally {
      close();
    }
  });

  it("applies MAX_DOCUMENT_BYTES when the device advertises no limit", async () => {
    const spool = await tempDir();
    const { host, close } = await serve(documentDriver(), spool);
    try {
      const byteLength = MAX_DOCUMENT_BYTES + 1;
      const huge: FileBandHandle = { transport: "file", path: join(spool, "huge.pdf"), sizeBytes: byteLength };
      await expect(
        host.request(PrinterDriverMethods.submitDocument, documentParams(huge, { byteLength })),
      ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams, data: { code: DocumentErrorCodes.tooLarge } });
    } finally {
      close();
    }
  });
});

describe("PrinterDriver conformance document checks", () => {
  const DOCUMENT_CHECKS = [
    "submitDocument accepts a small document from the spool",
    "submitDocument rejects a document whose size differs",
    "submitDocument rejects a document whose sha256 differs",
    "submitDocument rejects a document above the size limit",
    "submitDocument rejects a format the device does not advertise",
  ];

  it("runs no document checks for a band-only driver", async () => {
    const report = await runPrinterDriverConformance(bandDriver(), { spoolDir: await tempDir(), runId: "band" });
    expect(report.checks.filter((check) => /document/i.test(check.name))).toEqual([]);
  });

  it("passes a document driver and submits a tiny PDF through a spool file", async () => {
    const received: Received[] = [];
    const report = await runPrinterDriverConformance(documentDriver({ maxDocumentBytes: 1024 }, received), {
      spoolDir: await tempDir(),
      runId: "doc",
    });
    expect(report.checks.filter((check) => check.ok === false)).toEqual([]);
    expect(report.checks.map((check) => check.name)).toEqual(expect.arrayContaining(DOCUMENT_CHECKS));
    expect(report.passed).toBe(true);
    expect(received).toHaveLength(1);
    const bytes = received[0]?.bytes ?? new Uint8Array();
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    expect(received[0]?.params.byteLength).toBe(bytes.byteLength);
  });

  it("fails a device that advertises documentFormats without implementing submitDocument", async () => {
    const report = await runPrinterDriverConformance(documentDriver({}, [], false), {
      spoolDir: await tempDir(),
      runId: "missing",
    });
    expect(report.passed).toBe(false);
    expect(report.checks.filter((check) => check.ok === false).map((check) => check.name)).toEqual(DOCUMENT_CHECKS);
  });
});
