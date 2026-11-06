import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  BPP_PROTOCOL,
  Connection,
  PluginServer,
  PrinterDriverMethods,
  registerPrinterDriver,
  silentLogger,
  validatePluginManifest,
  type PrinterStatus,
  type SubmitResult,
} from "@bax-print/plugin-sdk";
import {
  BAND_INPUT_UNSUPPORTED,
  FOLDER_DEVICE_ID,
  FolderPrinterDriver,
  TICKET_VERSION,
} from "../src/driver.js";

const PDF = new TextEncoder().encode("%PDF-1.7\n% folder output test\n%%EOF\n");
const TIFF = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
const FIXED_NOW = new Date("2026-11-05T12:00:00.000Z");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A temp root with an `out` folder inside it: the folder is the fake device, the root shows any escape. */
async function fakeDevice(): Promise<{ root: string; outputDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "printer-folder-"));
  tempDirs.push(root);
  const outputDir = join(root, "out");
  await mkdir(outputDir);
  return { root, outputDir };
}

function newDriver(): FolderPrinterDriver {
  return new FolderPrinterDriver({ log: silentLogger }, { now: () => FIXED_NOW });
}

async function configuredDriver(
  settings: Record<string, unknown> = {},
): Promise<{ driver: FolderPrinterDriver; root: string; outputDir: string }> {
  const device = await fakeDevice();
  const driver = newDriver();
  driver.configure({ outputDir: device.outputDir, ...settings });
  return { driver, ...device };
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry: unknown) => stringValues(entry));
  if (value instanceof Object) return Object.values(value).flatMap((entry: unknown) => stringValues(entry));
  return [];
}

const BAD_SETTINGS: Array<{ label: string; settings: Record<string, unknown>; message: RegExp }> = [
  { label: "missing outputDir", settings: {}, message: /outputDir is required/ },
  { label: "relative outputDir", settings: { outputDir: "out" }, message: /must be an absolute path/ },
  { label: "non-string outputDir", settings: { outputDir: 42 }, message: /outputDir is required/ },
];

describe("printer-folder configuration", () => {
  it("applies the documented defaults", async () => {
    const { driver, outputDir } = await configuredDriver();
    expect(driver.describe()).toMatchObject({
      name: "Folder output",
      outputDir,
      acceptedFormats: ["pdf", "tiff"],
      writesTicket: true,
    });
  });

  it.each(BAD_SETTINGS)("rejects $label", ({ settings, message }) => {
    const error = thrownBy(() => newDriver().configure(settings));
    expect(error).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(message) });
  });

  it("rejects an outputDir that does not exist or is a file", async () => {
    const { root } = await fakeDevice();
    const file = join(root, "plain-file");
    await writeFile(file, "x");
    expect(thrownBy(() => newDriver().configure({ outputDir: join(root, "missing") }))).toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringMatching(/does not exist/),
    });
    expect(thrownBy(() => newDriver().configure({ outputDir: file }))).toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringMatching(/not a directory/),
    });
  });

  it.skipIf(isRoot || process.platform === "win32")("rejects an outputDir that is not writable", async () => {
    const { outputDir } = await fakeDevice();
    await chmod(outputDir, 0o555);
    try {
      expect(thrownBy(() => newDriver().configure({ outputDir }))).toMatchObject({
        code: "CONFIG_INVALID",
        message: expect.stringMatching(/not writable/),
      });
    } finally {
      await chmod(outputDir, 0o755);
    }
  });

  it("rejects bad optional settings and reports every problem at once", async () => {
    const { outputDir } = await fakeDevice();
    const error = thrownBy(() =>
      newDriver().configure({ outputDir, acceptedFormats: ["jpeg"], writeTicket: "yes", deviceName: " " }),
    );
    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    const message = error instanceof Error ? error.message : "";
    expect(message).toMatch(/unsupported format "jpeg"/);
    expect(message).toMatch(/writeTicket must be a boolean/);
    expect(message).toMatch(/deviceName must be a non-empty string/);
    expect(thrownBy(() => newDriver().configure({ outputDir, acceptedFormats: [] }))).toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("refuses to work before it is configured", async () => {
    const driver = newDriver();
    await expect(driver.submitDocument({ jobId: "job-1", format: "pdf", data: PDF })).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
    await expect(driver.discover()).resolves.toEqual({ devices: [] });
    await expect(driver.getStatus({ deviceId: FOLDER_DEVICE_ID })).resolves.toMatchObject({ state: "offline" });
  });
});

describe("printer-folder submit", () => {
  it("writes the output and the ticket atomically, leaving no part files", async () => {
    const { driver, outputDir } = await configuredDriver();
    const result = await driver.submitDocument({
      jobId: "job-1",
      format: "pdf",
      data: PDF,
      copies: 2,
      media: { name: "Satin 200", widthMm: 210, heightMm: 297 },
    });
    expect(result).toEqual({
      jobId: "job-1",
      outputPath: join(outputDir, "job-1.pdf"),
      ticketPath: join(outputDir, "job-1.bps-ticket.json"),
    });
    expect(await listing(outputDir)).toEqual(["job-1.bps-ticket.json", "job-1.pdf"]);
    expect(new Uint8Array(await readFile(join(outputDir, "job-1.pdf")))).toEqual(PDF);
    const ticket: unknown = JSON.parse(await readFile(join(outputDir, "job-1.bps-ticket.json"), "utf8"));
    expect(ticket).toEqual({
      bpsTicket: TICKET_VERSION,
      jobId: "job-1",
      file: "job-1.pdf",
      format: "pdf",
      copies: 2,
      media: { name: "Satin 200", widthMm: 210, heightMm: 297 },
      createdAt: "2026-11-05T12:00:00.000Z",
    });
  });

  it("records unknown media as null and defaults copies to 1", async () => {
    const { driver, outputDir } = await configuredDriver();
    await driver.submitDocument({ jobId: "job-t", format: "tiff", data: TIFF });
    expect(await listing(outputDir)).toEqual(["job-t.bps-ticket.json", "job-t.tiff"]);
    const ticket: unknown = JSON.parse(await readFile(join(outputDir, "job-t.bps-ticket.json"), "utf8"));
    expect(ticket).toMatchObject({ copies: 1, media: { name: null, widthMm: null, heightMm: null } });
  });

  it("replaces a stale part file and never follows a planted part symlink", async () => {
    const { driver, root, outputDir } = await configuredDriver({ writeTicket: false });
    const outside = join(root, "outside.txt");
    await writeFile(outside, "untouched");
    await symlink(outside, join(outputDir, "job-s.pdf.part"));
    await writeFile(join(outputDir, "job-p.pdf.part"), "half-written");
    await driver.submitDocument({ jobId: "job-s", format: "pdf", data: PDF });
    await driver.submitDocument({ jobId: "job-p", format: "pdf", data: PDF });
    expect(await readFile(outside, "utf8")).toBe("untouched");
    expect(await listing(outputDir)).toEqual(["job-p.pdf", "job-s.pdf"]);
    expect(new Uint8Array(await readFile(join(outputDir, "job-p.pdf")))).toEqual(PDF);
  });

  it("writes no ticket when writeTicket is false", async () => {
    const { driver, outputDir } = await configuredDriver({ writeTicket: false });
    const result = await driver.submitDocument({ jobId: "job-2", format: "pdf", data: PDF });
    expect(result.ticketPath).toBeNull();
    expect(await listing(outputDir)).toEqual(["job-2.pdf"]);
  });

  it("never overwrites an existing output or ticket (OUTPUT_EXISTS)", async () => {
    const { driver, outputDir } = await configuredDriver();
    await writeFile(join(outputDir, "job-3.pdf"), "old");
    await expect(driver.submitDocument({ jobId: "job-3", format: "pdf", data: PDF })).rejects.toMatchObject({
      code: "OUTPUT_EXISTS",
    });
    expect(await readFile(join(outputDir, "job-3.pdf"), "utf8")).toBe("old");

    await writeFile(join(outputDir, "job-4.bps-ticket.json"), "{}");
    await expect(driver.submitDocument({ jobId: "job-4", format: "pdf", data: PDF })).rejects.toMatchObject({
      code: "OUTPUT_EXISTS",
    });
    expect(await listing(outputDir)).toEqual(["job-3.pdf", "job-4.bps-ticket.json"]);

    await driver.submitDocument({ jobId: "job-5", format: "pdf", data: PDF });
    await expect(driver.submitDocument({ jobId: "job-5", format: "pdf", data: TIFF })).rejects.toMatchObject({
      code: "OUTPUT_EXISTS",
    });
    expect(new Uint8Array(await readFile(join(outputDir, "job-5.pdf")))).toEqual(PDF);
  });

  it("rejects formats that are not accepted (FORMAT_NOT_ACCEPTED)", async () => {
    const { driver, outputDir } = await configuredDriver({ acceptedFormats: ["pdf"] });
    await expect(driver.submitDocument({ jobId: "job-6", format: "tiff", data: TIFF })).rejects.toMatchObject({
      code: "FORMAT_NOT_ACCEPTED",
    });
    await expect(driver.submitDocument({ jobId: "job-6", format: "jpeg", data: PDF })).rejects.toMatchObject({
      code: "FORMAT_NOT_ACCEPTED",
    });
    expect(await listing(outputDir)).toEqual([]);
  });

  it.each([
    "",
    "..",
    "../escape",
    "../../etc/passwd",
    "a/b",
    "a\\b",
    "/absolute",
    ".hidden",
    "trailing.",
    "a..b",
    "space here",
    "x".repeat(129),
  ])("rejects the unsafe job id %j (INVALID_JOB_ID) and writes nothing", async (jobId) => {
    const { driver, root, outputDir } = await configuredDriver();
    await expect(driver.submitDocument({ jobId, format: "pdf", data: PDF })).rejects.toMatchObject({
      code: "INVALID_JOB_ID",
    });
    expect(await listing(outputDir)).toEqual([]);
    expect(await listing(root)).toEqual(["out"]);
  });

  it("rejects invalid copies, media and empty data (INVALID_SUBMISSION)", async () => {
    const { driver, outputDir } = await configuredDriver();
    await expect(driver.submitDocument({ jobId: "job-7", format: "pdf", data: PDF, copies: 0 })).rejects.toMatchObject({
      code: "INVALID_SUBMISSION",
    });
    await expect(
      driver.submitDocument({ jobId: "job-7", format: "pdf", data: PDF, media: { widthMm: -1 } }),
    ).rejects.toMatchObject({ code: "INVALID_SUBMISSION" });
    await expect(driver.submitDocument({ jobId: "job-7", format: "pdf", data: new Uint8Array() })).rejects.toMatchObject({
      code: "INVALID_SUBMISSION",
    });
    expect(await listing(outputDir)).toEqual([]);
  });
});

describe("printer-folder status and cancel", () => {
  it("reports queued while the file waits and done once a watcher removes it", async () => {
    const { driver, outputDir } = await configuredDriver();
    await driver.submitDocument({ jobId: "job-8", format: "pdf", data: PDF });
    await expect(driver.getJobStatus("job-8")).resolves.toMatchObject({ state: "queued" });
    await expect(driver.getStatus({ deviceId: FOLDER_DEVICE_ID })).resolves.toMatchObject({
      state: "idle",
      message: "1 file(s) waiting in the output folder",
    });

    await unlink(join(outputDir, "job-8.pdf"));
    await expect(driver.getJobStatus("job-8")).resolves.toMatchObject({ state: "done" });
    await expect(driver.getStatus({ deviceId: FOLDER_DEVICE_ID })).resolves.toEqual({
      deviceId: FOLDER_DEVICE_ID,
      state: "idle",
    });
    // The ticket belongs to the consumer now; the driver leaves it alone.
    expect(await listing(outputDir)).toEqual(["job-8.bps-ticket.json"]);
  });

  it("cancel removes the waiting file and its ticket", async () => {
    const { driver, outputDir } = await configuredDriver();
    await driver.submitDocument({ jobId: "job-9", format: "pdf", data: PDF });
    await expect(driver.cancelJob("job-9")).resolves.toMatchObject({ state: "cancelled" });
    expect(await listing(outputDir)).toEqual([]);
    await expect(driver.getJobStatus("job-9")).resolves.toMatchObject({ state: "cancelled" });
  });

  it("cancel after a watcher took the file leaves the ticket and reports done", async () => {
    const { driver, outputDir } = await configuredDriver();
    await driver.submitDocument({ jobId: "job-10", format: "pdf", data: PDF });
    await unlink(join(outputDir, "job-10.pdf"));
    await expect(driver.cancelJob("job-10")).resolves.toMatchObject({ state: "done" });
    expect(await listing(outputDir)).toEqual(["job-10.bps-ticket.json"]);
  });

  it("rejects unknown and unsafe job ids", async () => {
    const { driver } = await configuredDriver();
    await expect(driver.getJobStatus("never-submitted")).rejects.toMatchObject({ code: "UNKNOWN_JOB" });
    await expect(driver.cancelJob("../x")).rejects.toMatchObject({ code: "INVALID_JOB_ID" });
  });
});

describe("printer-folder describe and PrinterDriver/1", () => {
  it("describes itself honestly and minimally, naming no vendor or model", async () => {
    const { driver, outputDir } = await configuredDriver({ acceptedFormats: ["pdf"] });
    const description = driver.describe();
    expect(description).toEqual({
      deviceId: FOLDER_DEVICE_ID,
      name: "Folder output",
      transport: "file-drop",
      outputDir,
      acceptedFormats: ["pdf"],
      writesTicket: true,
      capabilities: { input: "document", colorants: [], bitsPerSample: [], resolutionsDpi: [], documentFormats: ["pdf"] },
    });
    // Apart from the configured path, every string the driver reports comes from this generic vocabulary.
    const generic = new Set(["folder-output", "Folder output", "file-drop", "document", "pdf", "tiff"]);
    const reported = stringValues({ ...description, outputDir: "" }).filter((value) => value.length > 0);
    expect(reported.filter((value) => generic.has(value) === false)).toEqual([]);
  });

  it("shows a free-text deviceName unchanged", async () => {
    const { driver } = await configuredDriver({ deviceName: "  Proof station  " });
    expect(driver.describe().name).toBe("Proof station");
    await expect(driver.discover()).resolves.toMatchObject({ devices: [{ deviceId: FOLDER_DEVICE_ID, name: "Proof station" }] });
  });

  it("answers media, accounting and band submissions as unsupported", async () => {
    const { driver } = await configuredDriver();
    const device = { deviceId: FOLDER_DEVICE_ID };
    await expect(driver.listMedia(device)).resolves.toEqual({ media: [] });
    await expect(driver.accounting(device)).resolves.toEqual({ records: [] });
    await expect(
      driver.submit({ ...device, jobId: "j", submissionId: "s", pageCount: 1, totalBands: 1, resolutionDpi: [72, 72] }),
    ).resolves.toEqual({ accepted: false, reason: BAND_INPUT_UNSUPPORTED });
    await expect(driver.complete({ submissionId: "s" })).rejects.toMatchObject({ code: -32602 });
    await expect(driver.listMedia({ deviceId: "other" })).rejects.toMatchObject({ code: -32602 });
    expect("listModes" in driver).toBe(false);
  });

  it("ships a manifest that satisfies the BPP manifest schema", async () => {
    const manifest: unknown = JSON.parse(await readFile(new URL("../bps-plugin.json", import.meta.url), "utf8"));
    expect(validatePluginManifest(manifest)).toEqual([]);
  });

  it("serves PrinterDriver/1 over BPP", async () => {
    const { root, outputDir } = await fakeDevice();
    const hostToPlugin = new PassThrough();
    const pluginToHost = new PassThrough();
    const server = new PluginServer({
      plugin: { id: "org.bax-print.printer.folder", name: "Folder Output Driver", version: "0.1.0" },
      offers: [{ interface: "PrinterDriver", version: "1.0.0" }],
      input: hostToPlugin,
      output: pluginToHost,
      log: silentLogger,
    });
    const driver = new FolderPrinterDriver(server);
    driver.configure({ outputDir });
    registerPrinterDriver(server, driver);
    const host = new Connection(pluginToHost, hostToPlugin);
    await host.request("initialize", {
      protocol: BPP_PROTOCOL,
      host: { name: "test-host", version: "0.0.0" },
      interfaces: [{ interface: "PrinterDriver", versions: ">=1.0 <2" }],
      spoolDir: root,
      capabilities: { transports: ["file"] },
    });
    await expect(host.request<PrinterStatus>(PrinterDriverMethods.getStatus, { deviceId: FOLDER_DEVICE_ID })).resolves.toEqual({
      deviceId: FOLDER_DEVICE_ID,
      state: "idle",
    });
    const submit = {
      deviceId: FOLDER_DEVICE_ID,
      jobId: "job-1",
      submissionId: "sub-1",
      pageCount: 1,
      totalBands: 1,
      resolutionDpi: [72, 72],
    };
    await expect(host.request<SubmitResult>(PrinterDriverMethods.submit, submit)).resolves.toMatchObject({ accepted: false });
    expect(await listing(outputDir)).toEqual([]);
    host.close();
    server.connection.close();
  });
});
