import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  BPP_PROTOCOL,
  CutterDriverError,
  CutterMethods,
  encodeMessage,
  MessageReader,
  parseManifest,
  RpcErrorCode,
  satisfiesRange,
  scrubEnv,
  serveBpp,
  serveCutterDriver,
  type CutterDriver,
  type JsonRpcMessage,
} from "../src/index.js";

/** Serves handlers over in-memory streams and returns a request function. */
function harness(start: (input: PassThrough, output: PassThrough) => void) {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new MessageReader();
  const waiting = new Map<number, (message: JsonRpcMessage) => void>();
  output.on("data", (chunk: Buffer) => {
    for (const raw of reader.push(chunk)) {
      const message = raw as JsonRpcMessage;
      waiting.get(message.id as number)?.(message);
    }
  });
  start(input, output);
  let nextId = 1;
  return (method: string, params?: unknown): Promise<JsonRpcMessage> => {
    const id = nextId++;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      input.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  };
}

describe("BPP framing", () => {
  it("decodes messages split across chunks and counts Content-Length in bytes", () => {
    const frames = Buffer.concat([encodeMessage({ a: "größe ✓" }), encodeMessage({ b: 2 })]);
    const reader = new MessageReader();
    const out: unknown[] = [];
    for (let i = 0; i < frames.length; i += 3) out.push(...reader.push(frames.subarray(i, i + 3)));
    expect(out).toEqual([{ a: "größe ✓" }, { b: 2 }]);
  });

  it("rejects frames without Content-Length", () => {
    expect(() => new MessageReader().push(Buffer.from("X-Other: 1\r\n\r\n{}"))).toThrow(/Content-Length/);
  });
});

describe("serveBpp", () => {
  it("answers initialize, $/ping, unknown methods and handler errors", async () => {
    const request = harness((input, output) =>
      serveBpp(
        { id: "test.plugin", version: "1.2.3", interfaces: [{ interface: "X", version: "1.0.0" }] },
        { "x/echo": (params) => params, "x/fail": () => Promise.reject(new Error("boom")) },
        { input, output, onExit: () => undefined },
      ),
    );
    const init = await request("initialize", { protocol: BPP_PROTOCOL });
    expect(init.result).toEqual({ protocol: BPP_PROTOCOL, plugin: { id: "test.plugin", version: "1.2.3" }, interfaces: [{ interface: "X", version: "1.0.0" }], capabilities: {} });
    expect((await request("$/ping")).result).toEqual({});
    expect((await request("x/echo", { v: 1 })).result).toEqual({ v: 1 });
    expect((await request("x/none")).error?.code).toBe(RpcErrorCode.MethodNotFound);
    const failed = await request("x/fail");
    expect(failed.error).toMatchObject({ code: RpcErrorCode.Internal, message: "boom" });
  });

  it("maps CutterDriverError codes onto PluginError responses", async () => {
    const driver: CutterDriver = {
      describe: () => {
        throw new CutterDriverError("invalid-device-config", "width missing");
      },
      formats: () => [],
      export: () => {
        throw new CutterDriverError("unsupported", "nope");
      },
    };
    const request = harness((input, output) => serveCutterDriver(driver, { id: "t", version: "0.0.1" }, { input, output, onExit: () => undefined }));
    const init = await request("initialize");
    expect((init.result as { interfaces: unknown }).interfaces).toEqual([{ interface: "CutterDriver", version: "2.0.0" }]);
    const describeError = await request(CutterMethods.describe, { deviceConfig: {} });
    expect(describeError.error).toMatchObject({ code: RpcErrorCode.PluginError, data: { code: "invalid-device-config" } });
    const exportError = await request(CutterMethods.export, { job: {}, format: "x" });
    expect(exportError.error).toMatchObject({ code: RpcErrorCode.PluginError, data: { code: "unsupported" } });
    // Optional methods the driver doesn't implement are not registered.
    expect((await request(CutterMethods.send, { job: {} })).error?.code).toBe(RpcErrorCode.MethodNotFound);
    expect((await request(CutterMethods.export, { format: "x" })).error?.code).toBe(RpcErrorCode.InvalidParams);
  });
});

describe("manifest and versions", () => {
  const manifest = {
    id: "p",
    name: "P",
    version: "0.1.0",
    license: "Apache-2.0",
    protocol: "bpp/1",
    provides: [{ interface: "CutterDriver", versions: ">=2.0 <3" }],
    exec: { command: "node", args: ["main.js"] },
  };

  it("parses valid manifests and rejects incomplete ones", () => {
    expect(parseManifest(manifest).id).toBe("p");
    expect(() => parseManifest({ ...manifest, provides: [] })).toThrow(/provides/);
    expect(() => parseManifest({ ...manifest, exec: {} })).toThrow(/exec.command/);
    expect(() => parseManifest({ ...manifest, exec: { command: "node", args: [1] } })).toThrow(/exec.args/);
    expect(() => parseManifest({ ...manifest, license: "" })).toThrow(/license/);
  });

  it.each([
    ["2.0.0", ">=2.0 <3", true],
    ["2.5.1", ">=2.0 <3", true],
    ["3.0.0", ">=2.0 <3", false],
    ["1.9.9", ">=2.0 <3", false],
    ["2.0.0", "2.0.0", true],
    ["2.0.1", "=2.0.0", false],
  ])("satisfiesRange(%s, %s) = %s", (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });

  it("scrubs the plugin environment down to an allowlist", () => {
    expect(scrubEnv({ PATH: "/bin", SECRET_TOKEN: "x", HOME: "/h" })).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});
