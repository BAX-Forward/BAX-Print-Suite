import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  BandMethods,
  BPP_PROTOCOL,
  Connection,
  PluginServer,
  PrinterDriverMethods,
  PrinterDriverNotifications,
  registerPrinterDriver,
  runPrinterDriverConformance,
  silentLogger,
  validatePluginManifest,
  writeFileBand,
  type BandReleaseParams,
  type CompleteResult,
  type SubmissionStatusNotification,
} from "@bax-print/plugin-sdk";
import { MOCK_DEVICE_ID, MockPrinterDriver } from "../src/driver.js";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "printer-mock-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("printer-mock", () => {
  it("passes the PrinterDriver/1 conformance suite", async () => {
    const spoolDir = await tempDir();
    const notifications: Array<{ method: string; params: unknown }> = [];
    const driver = new MockPrinterDriver({
      spoolDir,
      log: silentLogger,
      notify: (method, params) => {
        notifications.push({ method, params });
        return true;
      },
    });
    const report = await runPrinterDriverConformance(driver, { spoolDir, runId: "mock" });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(notifications.map((n) => n.method)).toContain(PrinterDriverNotifications.accountingRecord);
  });

  it("ships a manifest that satisfies the BPP manifest schema", async () => {
    const manifest: unknown = JSON.parse(await readFile(new URL("../bps-plugin.json", import.meta.url), "utf8"));
    expect(validatePluginManifest(manifest)).toEqual([]);
  });

  it("prints a submission over BPP and writes a summary into the spool", async () => {
    const spoolDir = await tempDir();
    const hostToPlugin = new PassThrough();
    const pluginToHost = new PassThrough();
    const server = new PluginServer({
      plugin: { id: "org.bax-print.printer.mock", name: "Mock Printer Driver", version: "0.1.0" },
      offers: [{ interface: "PrinterDriver", version: "1.0.0" }],
      input: hostToPlugin,
      output: pluginToHost,
      log: silentLogger,
    });
    registerPrinterDriver(server, new MockPrinterDriver(server));
    const host = new Connection(pluginToHost, hostToPlugin);
    const releases: BandReleaseParams[] = [];
    const states: string[] = [];
    host.onNotification<BandReleaseParams>(BandMethods.release, (params) => {
      releases.push(params);
    });
    host.onNotification<SubmissionStatusNotification>(PrinterDriverNotifications.submissionStatus, (params) => {
      states.push(params.state);
    });

    await host.request("initialize", {
      protocol: BPP_PROTOCOL,
      host: { name: "test-host", version: "0.0.0" },
      interfaces: [{ interface: "PrinterDriver", versions: ">=1.0 <2" }],
      spoolDir,
      capabilities: { transports: ["file"] },
    });
    await expect(host.request(PrinterDriverMethods.getStatus, {})).rejects.toMatchObject({ code: -32602 });
    const submit = {
      deviceId: MOCK_DEVICE_ID,
      jobId: "job-1",
      submissionId: "sub-1",
      pageCount: 1,
      totalBands: 2,
      resolutionDpi: [72, 72],
    };
    await expect(host.request(PrinterDriverMethods.submit, submit)).resolves.toEqual({ accepted: true });
    for (let index = 0; index < 2; index++) {
      const data = new Uint8Array(4 * 4 * 2).fill(index === 0 ? 0 : 5);
      const handle = await writeFileBand(spoolDir, `bands/sub-1-${index}.bin`, data);
      host.notify(BandMethods.data, {
        streamId: "sub-1",
        page: 0,
        last: index === 1,
        band: {
          bandId: `b${index}`,
          y0: index * 4,
          height: 4,
          width: 4,
          planes: [
            { colorant: "C", bitsPerSample: 8, stride: 4, offset: 0 },
            { colorant: "K", bitsPerSample: 8, stride: 4, offset: 16 },
          ],
          handle,
        },
      });
    }
    const result = await host.request<CompleteResult>(PrinterDriverMethods.complete, { submissionId: "sub-1" });
    expect(result).toMatchObject({ submissionId: "sub-1", state: "printed", bandsReceived: 2, bytesReceived: 64 });
    expect(releases).toEqual([
      { streamId: "sub-1", bandId: "b0" },
      { streamId: "sub-1", bandId: "b1" },
    ]);
    const summary = JSON.parse(await readFile(result.outputPath ?? "", "utf8")) as { bands: Array<{ inkedBytes: number }> };
    expect(summary.bands.map((band) => band.inkedBytes)).toEqual([0, 32]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(states).toEqual(["receiving", "printing", "printed"]);
    host.close();
    server.connection.close();
  });
});
