// Generic delivery helpers for CutterDriver/2 `send()` (spec 004 Part C):
// folder drops (atomic, so watched folders never see half-written files),
// raw TCP passthrough and writes to a user-chosen device path. Endpoints are
// always user-configured; nothing is discovered or probed.

import { randomBytes } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { basename, join } from "node:path";

export const DEFAULT_TCP_TIMEOUT_MS = 10_000;

/** Writes `bytes` to `dir/fileName` through a temporary name and a rename. Returns the final path. */
export async function writeFileAtomic(dir: string, fileName: string, bytes: Uint8Array): Promise<string> {
  const safeName = basename(fileName);
  if (safeName !== fileName || safeName.length === 0 || safeName === "." || safeName === "..") {
    throw new Error(`invalid file name "${fileName}"`);
  }
  const finalPath = join(dir, safeName);
  // Leading dot: most watched-folder importers ignore hidden files.
  const tempPath = join(dir, `.${safeName}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, bytes, { flag: "wx" });
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return finalPath;
}

export interface TcpEndpoint {
  host: string;
  port: number;
  timeoutMs?: number;
}

export function parseTcpEndpoint(raw: unknown): TcpEndpoint {
  if (typeof raw !== "object" || raw === null) throw new Error("tcp endpoint must be an object { host, port }");
  const { host, port, timeoutMs } = raw as Record<string, unknown>;
  if (typeof host !== "string" || host.trim().length === 0) throw new Error("tcp.host must be a non-empty string");
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new Error("tcp.port must be an integer in 1..65535");
  if (timeoutMs !== undefined && !(typeof timeoutMs === "number" && timeoutMs > 0)) throw new Error("tcp.timeoutMs must be > 0");
  return { host: host.trim(), port: port as number, ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }) };
}

/** Opens a raw socket, writes the bytes, half-closes and waits for the peer to finish. */
export function sendRawTcp(endpoint: TcpEndpoint, bytes: Uint8Array): Promise<void> {
  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_TCP_TIMEOUT_MS;
  return new Promise((resolveSend, rejectSend) => {
    let settled = false;
    const socket = connect({ host: endpoint.host, port: endpoint.port });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectSend(error);
      else resolveSend();
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`tcp ${endpoint.host}:${endpoint.port}: timed out after ${timeoutMs} ms`)));
    socket.on("error", (error) => finish(error));
    socket.on("connect", () => {
      socket.end(bytes, () => {
        // All data flushed. Wait briefly for the peer to close, but don't require it.
        socket.once("close", () => finish());
        socket.setTimeout(Math.min(timeoutMs, 2_000), () => finish());
      });
    });
    socket.on("close", () => finish());
  });
}

/** Writes bytes to an existing device path (e.g. a character device or printer port). Never creates files. */
export async function writeToDevicePath(devicePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(devicePath, "r+");
  try {
    await handle.write(bytes);
  } finally {
    await handle.close();
  }
}
