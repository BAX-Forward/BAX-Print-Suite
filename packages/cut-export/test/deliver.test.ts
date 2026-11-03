import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTcpEndpoint, sendRawTcp, writeFileAtomic, writeToDevicePath } from "../src/index.js";

/** A local raw-socket sink that collects everything one client sends. */
async function startSink(): Promise<{ server: Server; port: number; received: Promise<Buffer> }> {
  let resolveReceived: (data: Buffer) => void = () => undefined;
  const received = new Promise<Buffer>((resolve) => {
    resolveReceived = resolve;
  });
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      resolveReceived(Buffer.concat(chunks));
      socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, received };
}

describe("delivery helpers", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bps-cut-deliver-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes files atomically and leaves no temporary files", async () => {
    const bytes = new TextEncoder().encode("IN;PU;SP0;");
    const path = await writeFileAtomic(dir, "job.plt", bytes);
    expect(path).toBe(join(dir, "job.plt"));
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
    expect(await readdir(dir)).toEqual(["job.plt"]);
    // Overwrites an existing file of the same name.
    await writeFileAtomic(dir, "job.plt", new TextEncoder().encode("IN;"));
    expect(await readFile(path, "utf8")).toBe("IN;");
  });

  it("refuses file names that leave the folder", async () => {
    for (const name of ["../x.plt", "a/b.plt", "", ".", ".."]) {
      await expect(writeFileAtomic(dir, name, new Uint8Array([1]))).rejects.toThrow();
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it("sends raw bytes over TCP to a user-configured endpoint", async () => {
    const sink = await startSink();
    try {
      const bytes = new TextEncoder().encode("IN;SP1;PU0,0;PD400,0;PU;SP0;");
      await sendRawTcp({ host: "127.0.0.1", port: sink.port, timeoutMs: 5_000 }, bytes);
      expect(new Uint8Array(await sink.received)).toEqual(bytes);
    } finally {
      sink.server.close();
    }
  });

  it("reports connection failures", async () => {
    const sink = await startSink();
    const port = sink.port;
    await new Promise<void>((resolve) => sink.server.close(() => resolve()));
    await expect(sendRawTcp({ host: "127.0.0.1", port, timeoutMs: 2_000 }, new Uint8Array([1]))).rejects.toThrow();
  });

  it("validates TCP endpoints", () => {
    expect(parseTcpEndpoint({ host: " 10.0.0.5 ", port: 9100 })).toEqual({ host: "10.0.0.5", port: 9100 });
    for (const bad of [null, {}, { host: "", port: 1 }, { host: "h", port: 0 }, { host: "h", port: 70000 }, { host: "h", port: 1, timeoutMs: -1 }]) {
      expect(() => parseTcpEndpoint(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("writes to an existing device path but never creates one", async () => {
    const devicePath = join(dir, "device");
    await expect(writeToDevicePath(devicePath, new Uint8Array([65]))).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
    await writeFileAtomic(dir, "device", new Uint8Array());
    await writeToDevicePath(devicePath, new TextEncoder().encode("IN;"));
    expect(await readFile(devicePath, "utf8")).toBe("IN;");
  });
});
