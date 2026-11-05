import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CutterDriverError, type CutJob, type Point, type RegistrationMarks } from "@bax-print/plugin-sdk";
import { runCutterDriverConformance, runCutterDriverConformanceProcess } from "@bax-print/plugin-sdk/conformance";
import { makeContour, mmToPt, validateCutJob } from "@bax-print/cut-export";
import { createSummaS2Driver, DMPL_FORMAT_ID, HPGL_FORMAT_ID } from "../src/driver.js";
import { buildS2Profile, parseS2DeviceConfig } from "../src/profile.js";

const MANIFEST = fileURLToPath(new URL("../bps-plugin.json", import.meta.url));
const DEVICE = { workAreaWidthMm: 1600 };

const pt = (points: [number, number][]): Point[] => points.map(([x, y]) => [mmToPt(x), mmToPt(y)]);

function goldenJob(patch: Partial<CutJob> = {}): CutJob {
  return {
    jobId: "s2-golden",
    contours: [
      makeContour({ id: "c1", tool: "kiss", closed: true, points: pt([[10, 10], [110, 10], [110, 60], [10, 60]]) }),
      makeContour({ id: "c2", tool: "pen", closed: false, points: pt([[20, 90], [60, 90]]) }),
      makeContour({ id: "c3", tool: "perforate", closed: false, points: pt([[30, 40], [90, 40]]) }),
    ],
    toolMap: { kiss: { toolId: "knife" }, pen: { toolId: "pen" }, perforate: { toolId: "pouncing" } },
    frame: { widthPt: mmToPt(200), heightPt: mmToPt(100) },
    options: {},
    ...patch,
  };
}

const MARK_CENTERS_MM: [number, number][] = [[5, 5], [195, 5], [5, 95], [195, 95]];

/** Square sensor marks in rows down both long edges (generic edge-rows pattern). */
const edgeRowMarks = (): RegistrationMarks => ({
  method: "edge-mark-rows",
  shape: "square",
  originMarkId: "m0",
  marks: MARK_CENTERS_MM.map(([x, y], i) => ({ id: `m${i}`, xPt: mmToPt(x), yPt: mmToPt(y), dPt: mmToPt(3) })),
});

const GOLDEN_HPGL = [
  "IN;",
  "SP1;",
  "PU400,400;",
  "PD4400,400,4400,2400,400,2400,400,400;",
  "SP2;",
  "PU800,3600;",
  "PD2400,3600;",
  "SP3;",
  "PU1200,1600;",
  "PD3600,1600;",
  "PU;",
  "SP0;",
  "",
].join("\n");

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function errorCode(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    return error instanceof CutterDriverError ? error.code : `not a CutterDriverError: ${String(error)}`;
  }
  return undefined;
}

describe("cutter-summa-s2 conformance", () => {
  it("passes the CutterDriver/2 kit in-process", async () => {
    const report = await runCutterDriverConformance(createSummaS2Driver(), { deviceConfig: DEVICE });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("passes the kit as a separate process over BPP, with spooled artifacts", async () => {
    const report = await runCutterDriverConformanceProcess(MANIFEST, { deviceConfig: DEVICE });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.passed).toBe(true);
  });
});

describe("cutter-summa-s2 HPGL export", () => {
  it("matches the golden HPGL with one SP per physical tool", async () => {
    const result = await createSummaS2Driver().export(goldenJob(), HPGL_FORMAT_ID);
    expect(decode(result.bytes)).toBe(GOLDEN_HPGL);
    expect(result.fileName).toBe("s2-golden.plt");
    expect(result.warnings).toEqual([]);
  });

  it("sends VS only on opt-in and never sends a force command", async () => {
    const driver = createSummaS2Driver();
    const plain = decode((await driver.export(goldenJob({ options: { velocity: 30 } }), HPGL_FORMAT_ID)).bytes);
    expect(plain).not.toMatch(/VS|FS/);
    const opted = await driver.export(goldenJob({ options: { sendVelocity: true, velocity: 30, sendForce: true, force: 120 } }), HPGL_FORMAT_ID);
    const text = decode(opted.bytes);
    expect(text.startsWith("IN;\nSP1;\nVS30;\nPU400,400;")).toBe(true);
    expect(text).not.toContain("FS");
    expect(opted.warnings).toContain("sendForce ignored: no documented force command; set force on the cutter");
  });

  it("lets penMap override the default pen numbers", async () => {
    const result = await createSummaS2Driver().export(goldenJob({ options: { penMap: { knife: 5 } } }), HPGL_FORMAT_ID);
    expect(decode(result.bytes)).toContain("SP5;\nPU400,400;");
  });

  it('returns "unsupported" for the reserved dmpl format, unknown formats and barcode job ids', async () => {
    const driver = createSummaS2Driver();
    expect(await errorCode(() => driver.export(goldenJob(), DMPL_FORMAT_ID))).toBe("unsupported");
    expect(await errorCode(() => driver.export(goldenJob(), "dxf"))).toBe("unsupported");
    expect(await errorCode(() => driver.export(goldenJob({ options: { barcodeJobId: true } }), HPGL_FORMAT_ID))).toBe("unsupported");
  });

  it('returns "experimental-disabled" for OPOS-style edge-mark-rows unless explicitly enabled', async () => {
    const driver = createSummaS2Driver();
    expect(await errorCode(() => driver.export(goldenJob({ marks: edgeRowMarks() }), HPGL_FORMAT_ID))).toBe("experimental-disabled");
    expect(await errorCode(() => driver.export(goldenJob({ options: { opos: true } }), HPGL_FORMAT_ID))).toBe("experimental-disabled");

    const enabled = await driver.export(goldenJob({ marks: edgeRowMarks(), options: { enableExperimentalOpos: true } }), HPGL_FORMAT_ID);
    const text = decode(enabled.bytes);
    // Coordinates are relative to the origin mark at (5, 5) mm: (10, 10) mm -> (5, 5) mm -> 200 plotter units.
    expect(text).toContain("PU200,200;");
    expect(enabled.warnings.some((w) => w.startsWith("experimental:"))).toBe(true);
  });
});

describe("cutter-summa-s2 profile", () => {
  it("declares a roll profile from user-entered device configuration", () => {
    const profile = buildS2Profile(parseS2DeviceConfig({ ...DEVICE, maxPanelLengthMm: 1500 }));
    expect(profile.class).toBe("roll");
    expect(profile.workArea).toEqual({ widthMm: 1600 });
    expect(profile.roll).toMatchObject({ maxPanelLengthMm: 1500, loadOrigin: "bottom-left", supportsPanelAdvance: false });
    expect(profile.tools.map((t) => [t.id, t.kind])).toEqual([
      ["knife", "drag-knife"],
      ["pen", "pen"],
      ["pouncing", "pouncing"],
    ]);
    expect(profile.registration).toMatchObject({
      methods: ["none"],
      experimental: ["edge-mark-rows"],
      supportsDeformationComp: ["x", "xy", "segmented"],
      barcodeJobId: { supported: true, documented: false },
    });
    expect(profile.delivery).toEqual(["file", "usb", "tcp"]);
    expect(profile.formats).toEqual(["hpgl"]);
  });

  it("lists edge-mark-rows and a tangential knife only when configured", () => {
    const profile = buildS2Profile(parseS2DeviceConfig({ ...DEVICE, knife: "tangential", enableExperimentalOpos: true, velocityRangeCmPerS: { min: 1, max: 80 } }));
    expect(profile.registration.methods).toEqual(["none", "edge-mark-rows"]);
    expect(profile.tools[0]).toEqual({ id: "knife", kind: "tangential-knife", params: { speed: { min: 1, max: 80, unit: "cm/s" } } });
  });

  it("makes core validation reject edge-mark-rows by default, with a hint", () => {
    const report = validateCutJob(goldenJob({ marks: edgeRowMarks() }), buildS2Profile(parseS2DeviceConfig(DEVICE)));
    expect(report.errors.map((e) => e.code)).toEqual(["registration-unsupported"]);
    expect(report.errors[0]?.message).toContain("experimental");
  });

  it.each([
    [{}, "workAreaWidthMm"],
    [{ ...DEVICE, knife: "laser" }, "knife"],
    [{ ...DEVICE, loadOrigin: "center" }, "loadOrigin"],
    [{ ...DEVICE, velocityRangeCmPerS: { min: 9, max: 1 } }, "velocityRangeCmPerS"],
    [{ ...DEVICE, delivery: { method: "tcp", tcp: { host: "h", port: 0 } } }, "tcp.port"],
    [{ ...DEVICE, delivery: { method: "ftp" } }, "delivery.method"],
  ])("rejects invalid device config %j", (config, message) => {
    try {
      parseS2DeviceConfig(config);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CutterDriverError);
      expect((error as CutterDriverError).code).toBe("invalid-device-config");
      expect((error as Error).message).toContain(message);
    }
  });
});

describe("cutter-summa-s2 delivery", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bps-s2-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the HPGL file to the configured folder", async () => {
    const result = await createSummaS2Driver().send?.(goldenJob(), { ...DEVICE, delivery: { method: "file", outputDir: dir } });
    expect(result).toEqual({ status: "delivered", detail: join(dir, "s2-golden.plt") });
    expect(await readFile(join(dir, "s2-golden.plt"), "utf8")).toBe(GOLDEN_HPGL);
  });

  it("fails without a delivery and keeps unverified TCP/USB off by default", async () => {
    const driver = createSummaS2Driver();
    expect((await driver.send?.(goldenJob(), DEVICE))?.status).toBe("failed");
    const tcp = await driver.send?.(goldenJob(), { ...DEVICE, delivery: { method: "tcp", tcp: { host: "127.0.0.1", port: 9 } } });
    expect(tcp).toMatchObject({ status: "failed", detail: expect.stringContaining("not verified") });
    const usb = await driver.send?.(goldenJob(), { ...DEVICE, delivery: { method: "usb", devicePath: join(dir, "dev") } });
    expect(usb).toMatchObject({ status: "failed", detail: expect.stringContaining("not verified") });
  });

  it("passes our own HPGL through raw TCP to a user-entered endpoint once enabled", async () => {
    const received = new Promise<string>((resolve) => {
      const server = createServer((socket) => {
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf8"));
          socket.end();
          server.close();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        const delivery = { method: "tcp", tcp: { host: "127.0.0.1", port, timeoutMs: 5_000 }, enableUnverified: true };
        void Promise.resolve(createSummaS2Driver().send?.(goldenJob(), { ...DEVICE, delivery })).then((result) =>
          expect(result?.status).toBe("delivered"),
        );
      });
    });
    expect(await received).toBe(GOLDEN_HPGL);
  });

  it("reports an unknown device state (no documented status query)", async () => {
    expect(await createSummaS2Driver().getStatus?.(DEVICE)).toEqual({ state: "unknown", reason: "no documented status query" });
  });
});
