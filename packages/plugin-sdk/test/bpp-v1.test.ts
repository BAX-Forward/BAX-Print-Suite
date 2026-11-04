import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { BPP_PROTOCOL, RpcError } from "../src/index.js";
import {
  Connection,
  encodeFrame,
  ErrorCodes,
  FrameDecoder,
  FramingError,
  MAX_MESSAGE_BYTES,
  negotiateInterfaces,
  negotiateVersion,
  PluginServer,
  readFileBand,
  runPrinterDriverConformance,
  silentLogger,
  toErrorObject,
  validatePluginManifest,
  writeFileBand,
  type PrinterDriverV1,
} from "../src/bpp/index.js";

/** Two connected endpoints over in-memory streams. */
function pair() {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  return { a: new Connection(bToA, aToB), b: new Connection(aToB, bToA), aToB, bToA };
}

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bpp-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("BPP v1 framing", () => {
  it("round-trips messages split at every byte, counting Content-Length in UTF-8 bytes", () => {
    const messages = [{ jsonrpc: "2.0", id: 1, method: "x", params: { s: "größe ✓" } }, { n: 2 }, []];
    const wire = Buffer.concat(messages.map((m) => encodeFrame(m)));
    expect(wire.toString("ascii")).toContain(`Content-Length: ${Buffer.byteLength(JSON.stringify(messages[0]))}\r\n\r\n`);
    const decoder = new FrameDecoder();
    const bodies: string[] = [];
    for (let i = 0; i < wire.length; i++) bodies.push(...decoder.push(wire.subarray(i, i + 1)));
    expect(bodies.map((body) => JSON.parse(body))).toEqual(messages);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("rejects frames larger than the message limit before buffering the body", () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.push(`Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n{`)).toThrow(FramingError);
    expect(() => new FrameDecoder().push(`Content-Length: ${MAX_MESSAGE_BYTES}\r\n\r\n{`)).not.toThrow();
  });

  it("rejects oversized headers, missing and malformed Content-Length", () => {
    expect(() => new FrameDecoder().push("X".repeat(9 * 1024))).toThrow(/Header exceeds/);
    expect(() => new FrameDecoder().push("X-Other: 1\r\n\r\n{}")).toThrow(/Missing Content-Length/);
    expect(() => new FrameDecoder().push("Content-Length: -4\r\n\r\n{}")).toThrow(/Invalid Content-Length/);
  });

  it("closes the connection when the peer sends an oversized frame", async () => {
    const input = new PassThrough();
    const connection = new Connection(input, new PassThrough());
    const pending = connection.request("x/never");
    const closed = new Promise<Error>((resolve) => connection.onClose(resolve));
    input.write(`Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n`);
    expect(await closed).toBeInstanceOf(FramingError);
    expect(connection.isClosed).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(FramingError);
  });
});

describe("JSON-RPC error mapping", () => {
  it("maps handler errors, unknown methods, guards and timeouts to JSON-RPC codes", async () => {
    const { a, b } = pair();
    b.onRequest("x/plugin", () => {
      throw new RpcError(ErrorCodes.PluginError, "bad media", { code: "media" });
    });
    b.onRequest("x/crash", () => {
      throw new Error("boom");
    });
    b.onRequest("x/slow", () => new Promise(() => undefined));
    b.onRequest("x/ok", (params) => params);

    await expect(a.request("x/ok", { v: 1 })).resolves.toEqual({ v: 1 });
    await expect(a.request("x/plugin")).rejects.toMatchObject({
      code: ErrorCodes.PluginError,
      message: "bad media",
      data: { code: "media" },
    });
    await expect(a.request("x/crash")).rejects.toMatchObject({ code: ErrorCodes.InternalError, message: "boom" });
    await expect(a.request("x/missing")).rejects.toMatchObject({ code: ErrorCodes.MethodNotFound });
    await expect(a.request("x/slow", undefined, { timeoutMs: 10 })).rejects.toMatchObject({
      code: ErrorCodes.RequestTimeout,
    });
    b.setRequestGuard((method) => new RpcError(ErrorCodes.NotInitialized, `Not initialized: ${method}`));
    await expect(a.request("x/ok")).rejects.toMatchObject({ code: ErrorCodes.NotInitialized });
    a.close();
    b.close();
  });

  it("dispatches a notification before a request that follows it in the same chunk", async () => {
    const input = new PassThrough();
    const connection = new Connection(input, new PassThrough());
    const order: string[] = [];
    let notified = false;
    connection.onNotification("x/note", () => {
      order.push("note");
      notified = true;
    });
    const seen = new Promise<boolean>((resolve) =>
      connection.onRequest("x/req", () => {
        order.push("req");
        resolve(notified);
        return null;
      }),
    );
    input.write(
      Buffer.concat([
        encodeFrame({ jsonrpc: "2.0", method: "x/note" }),
        encodeFrame({ jsonrpc: "2.0", id: 1, method: "x/req" }),
      ]),
    );
    expect(await seen).toBe(true);
    expect(order).toEqual(["note", "req"]);
    connection.close();
  });

  it("converts thrown values to error objects", () => {
    expect(toErrorObject(new RpcError(ErrorCodes.InvalidParams, "p"))).toEqual({ code: -32602, message: "p" });
    expect(toErrorObject("text")).toEqual({ code: -32603, message: "text" });
  });

  it("answers unparseable bodies with a ParseError", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    new Connection(input, output);
    const decoder = new FrameDecoder();
    const reply = new Promise<unknown>((resolve) =>
      output.on("data", (chunk: Buffer) => decoder.push(chunk).forEach((body) => resolve(JSON.parse(body)))),
    );
    input.write("Content-Length: 3\r\n\r\n{x}");
    expect(await reply).toMatchObject({ id: null, error: { code: ErrorCodes.ParseError } });
  });
});

describe("version negotiation", () => {
  it("picks the highest common minor", () => {
    expect(negotiateVersion(["1.0.0", "1.1.0", "1.2.0", "2.0.0"], ["1.1.4", "1.2.3", "1.3.0"])).toBe("1.2.0");
    expect(negotiateVersion(["1.4.2", "1.4.7"], ["1.4.5"])).toBe("1.4.5");
    expect(negotiateVersion(["2.0.0"], ["1.9.0"])).toBeUndefined();
    expect(negotiateVersion(["junk", "1.0.0"], ["1.0.0"])).toBe("1.0.0");
  });

  it("selects the highest offer inside each required range and reports the rest", () => {
    const result = negotiateInterfaces(
      [
        { interface: "PrinterDriver", versions: ">=1.0 <2" },
        { interface: "Inspector", versions: "^1.0.0" },
      ],
      [
        { interface: "PrinterDriver", version: "1.0.0" },
        { interface: "PrinterDriver", version: "1.3.0" },
        { interface: "PrinterDriver", version: "2.0.0" },
      ],
    );
    expect(result.selected).toEqual([{ interface: "PrinterDriver", version: "1.3.0" }]);
    expect(result.missing).toEqual([{ interface: "Inspector", versions: "^1.0.0" }]);
  });
});

describe("plugin manifest schema", () => {
  const manifest = {
    id: "org.example.printer.sample",
    name: "Sample",
    version: "0.1.0",
    license: "Apache-2.0",
    provides: [{ interface: "PrinterDriver", versions: ">=1.0 <2" }],
    protocol: BPP_PROTOCOL,
    exec: { command: "node", args: ["dist/main.js"] },
  };

  it("accepts a complete manifest and ignores unknown fields", () => {
    expect(validatePluginManifest({ ...manifest, futureField: true })).toEqual([]);
  });

  it.each(["id", "name", "version", "license", "provides", "protocol", "exec"])("rejects a manifest missing %s", (field) => {
    const incomplete: Record<string, unknown> = { ...manifest };
    delete incomplete[field];
    expect(validatePluginManifest(incomplete)).toContainEqual({ path: `/${field}`, message: "is required" });
  });

  it("rejects nested missing fields, bad versions and bad ranges", () => {
    expect(validatePluginManifest({ ...manifest, exec: {} })).toContainEqual({ path: "/exec/command", message: "is required" });
    expect(validatePluginManifest({ ...manifest, provides: [{ interface: "PrinterDriver" }] })).toContainEqual({
      path: "/provides/0/versions",
      message: "is required",
    });
    expect(validatePluginManifest({ ...manifest, version: "1.0" }).map((e) => e.path)).toEqual(["/version"]);
    expect(validatePluginManifest({ ...manifest, provides: [{ interface: "PrinterDriver", versions: ">=x" }] })).toEqual([
      { path: "/provides/0/versions", message: "must be a valid SemVer range" },
    ]);
  });
});

describe("file band transport", () => {
  it("reads bands inside the spool and refuses paths outside it or with a wrong size", async () => {
    const spool = await tempDir();
    const outside = await tempDir();
    const handle = await writeFileBand(spool, "s/band-0.bin", new Uint8Array([1, 2, 3]));
    expect([...(await readFileBand(handle, spool))]).toEqual([1, 2, 3]);
    await expect(readFileBand({ ...handle, sizeBytes: 4 }, spool)).rejects.toThrow(/size mismatch/);
    const foreign = await writeFileBand(outside, "x.bin", new Uint8Array([9]));
    await expect(readFileBand(foreign, spool)).rejects.toThrow(/outside the spool/);
    await expect(writeFileBand(spool, "../escape.bin", new Uint8Array([0]))).rejects.toThrow(/outside/);
  });
});

describe("PluginServer lifecycle", () => {
  it("guards calls before initialize and negotiates interfaces", async () => {
    const hostToPlugin = new PassThrough();
    const pluginToHost = new PassThrough();
    const exits: number[] = [];
    const server = new PluginServer({
      plugin: { id: "org.example.test", name: "Test", version: "0.0.1" },
      offers: [{ interface: "PrinterDriver", version: "1.0.0" }],
      input: hostToPlugin,
      output: pluginToHost,
      log: silentLogger,
      onExit: (code) => exits.push(code),
    });
    server.onRequest("printer/discover", () => ({ devices: [] }));
    const host = new Connection(pluginToHost, hostToPlugin);
    const spoolDir = await tempDir();
    const init = {
      protocol: BPP_PROTOCOL,
      host: { name: "test-host", version: "0.0.0" },
      interfaces: [{ interface: "PrinterDriver", versions: ">=1.0 <2" }],
      spoolDir,
      capabilities: { transports: ["file"] },
    };

    await expect(host.request("printer/discover")).rejects.toMatchObject({ code: ErrorCodes.NotInitialized });
    await expect(host.request("$/ping")).resolves.toMatchObject({ time: expect.any(Number) });
    await expect(host.request("initialize", { ...init, protocol: "bpp/9" })).rejects.toMatchObject({
      code: ErrorCodes.UnsupportedVersion,
    });
    await expect(
      host.request("initialize", { ...init, interfaces: [{ interface: "PrinterDriver", versions: "^2" }] }),
    ).rejects.toMatchObject({ code: ErrorCodes.UnsupportedVersion });
    await expect(host.request("initialize", { ...init, spoolDir: "" })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
    await expect(host.request("initialize", init)).resolves.toMatchObject({
      protocol: BPP_PROTOCOL,
      interfaces: [{ interface: "PrinterDriver", version: "1.0.0" }],
    });
    expect(server.spoolDir).toBe(spoolDir);
    await expect(host.request("initialize", init)).rejects.toMatchObject({ code: ErrorCodes.InvalidRequest });
    await expect(host.request("printer/discover")).resolves.toEqual({ devices: [] });
    await expect(host.request("shutdown")).resolves.toBeNull();
    await new Promise((resolve) => setImmediate(resolve));
    expect(exits).toEqual([0]);
    host.close();
  });
});

describe("PrinterDriver conformance suite", () => {
  it("fails a lax driver on the checks it violates", async () => {
    const lax: PrinterDriverV1 = {
      discover: async () => ({
        devices: [
          {
            deviceId: "d1",
            name: "Lax",
            capabilities: { input: "bands", colorants: ["K"], bitsPerSample: [8], resolutionsDpi: [[72, 72]] },
          },
        ],
      }),
      getStatus: async ({ deviceId }) => ({ deviceId, state: "idle" }),
      listMedia: async () => ({ media: [] }),
      submit: async () => ({ accepted: true }),
      onBand: async () => undefined,
      complete: async ({ submissionId }) => ({ submissionId, state: "printed", bandsReceived: 0, bytesReceived: 0 }),
      cancel: async () => undefined,
      accounting: async () => ({ records: [] }),
    };
    const report = await runPrinterDriverConformance(lax, { spoolDir: await tempDir(), runId: "lax" });
    expect(report.passed).toBe(false);
    expect(report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      "getStatus rejects an unknown device",
      "a complete submission is printed with matching totals",
      "a duplicate submissionId is refused",
      "complete fails when bands are missing",
      "a cancelled submission cannot be completed",
      "bands for an unknown submission are rejected",
    ]);
  });

  it("stops after discovery when no device is found", async () => {
    const empty = { discover: async () => ({ devices: [] }) } as unknown as PrinterDriverV1;
    const report = await runPrinterDriverConformance(empty, { spoolDir: await tempDir() });
    expect(report).toEqual({
      passed: false,
      checks: [{ name: "discover lists a well-formed device", ok: false, detail: "no devices discovered" }],
    });
  });
});
