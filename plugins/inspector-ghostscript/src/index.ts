import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { BuiltinInspector } from "@bax-print/inspect";
import type { FixupRequest, FixupResult, InspectRequest, Inspector, PreflightReport } from "@bax-print/plugin-sdk";
import {
  DEFAULT_TIMEOUT_MS,
  FIXUP_TARGETS,
  buildFixupArgs,
  defaultCommand,
  detectVersion,
  isFixupTarget,
  runGhostscript,
  type FixupOptions,
  type GhostscriptCommand,
} from "./ghostscript.js";

export * from "./ghostscript.js";

/**
 * `Inspector/1` plugin (Spec 007 FR3). `inspect()` runs the built-in checks inside this
 * process; `fixup()` rewrites the document to a PDF/X or PDF/A level with Ghostscript and
 * returns a handle to the new file. The source document is only read, never written.
 */

export const PLUGIN_ID = "org.bax-print.inspector.ghostscript";
export const PLUGIN_VERSION = "0.1.0";

export class FixupFailedError extends Error {
  readonly log: string[];

  constructor(message: string, log: string[]) {
    super(message);
    this.name = "FixupFailedError";
    this.log = log;
  }
}

export interface GhostscriptInspectorOptions {
  ghostscript?: GhostscriptCommand;
  timeoutMs?: number;
  /** Environment for the Ghostscript process. Default: `PATH` only. */
  env?: NodeJS.ProcessEnv;
}

function optionsOf(input: Record<string, unknown> | undefined): FixupOptions {
  const text = (key: string): string | undefined => (typeof input?.[key] === "string" && input[key] !== "" ? (input[key] as string) : undefined);
  const conversion = text("colorConversion");
  if (conversion !== undefined && conversion !== "CMYK" && conversion !== "RGB") {
    throw new TypeError(`colorConversion must be CMYK or RGB, got ${JSON.stringify(conversion)}`);
  }
  return { outputIntentProfile: text("outputIntentProfile"), definitionFile: text("definitionFile"), colorConversion: conversion };
}

function slug(target: string): string {
  return target.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export class GhostscriptInspector implements Inspector {
  readonly id = PLUGIN_ID;
  readonly version = PLUGIN_VERSION;
  readonly fixupTargets: readonly string[] = FIXUP_TARGETS;
  private readonly builtin = new BuiltinInspector();
  private readonly gs: GhostscriptCommand;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(options: GhostscriptInspectorOptions = {}) {
    this.gs = options.ghostscript ?? defaultCommand();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.env = options.env;
  }

  /** Dynamic capabilities for `initialize`: whether Ghostscript is installed, and its version. */
  async capabilities(): Promise<Record<string, unknown>> {
    const version = await detectVersion(this.gs, this.env);
    return { ghostscript: { available: version !== undefined, ...(version ? { version } : {}) } };
  }

  inspect(request: InspectRequest, signal?: AbortSignal): Promise<PreflightReport> {
    return this.builtin.inspect(request, signal);
  }

  async fixup(request: FixupRequest, signal?: AbortSignal): Promise<FixupResult> {
    if (!isFixupTarget(request.target)) throw new TypeError(`Unsupported fixup target ${JSON.stringify(request.target)}`);
    const options = optionsOf(request.options);
    const input = path.resolve(request.document.path);
    await mkdir(request.outputDir, { recursive: true });
    const base = path.basename(input, path.extname(input));
    const output = path.resolve(request.outputDir, `${base}.${slug(request.target)}.${randomUUID()}.pdf`);
    if (output === input) throw new Error("Output path equals the source path");

    const args = buildFixupArgs(request.target, input, output, options);
    const result = await runGhostscript(this.gs, args, { timeoutMs: this.timeoutMs, signal, env: this.env });
    if (result.exitCode !== 0) {
      await rm(output, { force: true });
      const reason = result.signal ? `was stopped by ${result.signal}` : `exited with code ${result.exitCode}`;
      throw new FixupFailedError(`Ghostscript ${reason}: ${result.log.slice(-5).join(" | ")}`, result.log);
    }
    const bytes = await readFile(output).catch(() => undefined);
    if (!bytes || bytes.length === 0) throw new FixupFailedError("Ghostscript reported success but wrote no file", result.log);
    try {
      await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    } catch (error) {
      await rm(output, { force: true });
      throw new FixupFailedError(`Ghostscript output is not a readable PDF: ${(error as Error).message}`, result.log);
    }
    const info = await stat(output);
    return {
      document: { kind: "file", path: output, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: info.size },
      target: request.target,
      log: result.log,
    };
  }
}
