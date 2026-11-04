import { spawn } from "node:child_process";

/**
 * Thin wrapper around a user-installed Ghostscript, run as a separate program (ADR-0004).
 * Nothing here links or bundles Ghostscript; it only builds a command line and runs it.
 *
 * The pdfwrite options used are the documented `-dPDFX` / `-dPDFA` switches. The output
 * intent profile and the optional definition file are supplied by the user, because the
 * profiles are not ours to ship. Verify the switches against the installed version's docs.
 */

export const FIXUP_TARGETS = ["PDF/X-3:2002", "PDF/A-2b"] as const;
export type FixupTarget = (typeof FIXUP_TARGETS)[number];

export const DEFAULT_TIMEOUT_MS = 600_000;
const VERSION_TIMEOUT_MS = 10_000;
const MAX_LOG_LINES = 200;

export interface GhostscriptCommand {
  /** Executable. Default `gswin64c` on Windows, else `gs`; `BPS_GHOSTSCRIPT` overrides. */
  command: string;
  /** Arguments placed before Ghostscript's own (lets tests run a stand-in through `node`). */
  prefixArgs?: readonly string[];
}

export interface FixupOptions {
  /** ICC profile for the output intent (PDF/X: the printing condition; PDF/A: the output profile). */
  outputIntentProfile?: string;
  /** `CMYK` (default for PDF/X) or `RGB` (default for PDF/A). */
  colorConversion?: "CMYK" | "RGB";
  /** Optional user-supplied PostScript definition file (e.g. an edited `PDFX_def.ps`). */
  definitionFile?: string;
}

export function isFixupTarget(value: string): value is FixupTarget {
  return (FIXUP_TARGETS as readonly string[]).includes(value);
}

export function defaultCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): GhostscriptCommand {
  const configured = env.BPS_GHOSTSCRIPT?.trim();
  if (configured) return { command: configured };
  return { command: platform === "win32" ? "gswin64c" : "gs" };
}

/** pdfwrite arguments for a target. Paths are passed as separate argv entries, never through a shell. */
export function buildFixupArgs(target: FixupTarget, input: string, output: string, options: FixupOptions = {}): string[] {
  const args = ["-dBATCH", "-dNOPAUSE", "-dSAFER", "-dQUIET", "-sDEVICE=pdfwrite"];
  const readable = [options.outputIntentProfile, options.definitionFile].filter((p): p is string => Boolean(p));
  // -dSAFER blocks file reads not on the command line; the profile is read from PostScript.
  for (const path of readable) args.push(`--permit-file-read=${path}`);
  if (target === "PDF/X-3:2002") {
    args.push("-dPDFX", `-sColorConversionStrategy=${options.colorConversion ?? "CMYK"}`);
  } else {
    args.push("-dPDFA=2", "-dPDFACompatibilityPolicy=1", `-sColorConversionStrategy=${options.colorConversion ?? "RGB"}`);
  }
  if (options.outputIntentProfile) args.push(`-sOutputICCProfile=${options.outputIntentProfile}`);
  args.push(`-sOutputFile=${output}`);
  if (options.definitionFile) args.push(options.definitionFile);
  args.push(input);
  return args;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  log: string[];
}

export class GhostscriptNotFoundError extends Error {
  constructor(command: string, options?: { cause?: unknown }) {
    super(`Ghostscript was not found (tried "${command}"). Install it, or set BPS_GHOSTSCRIPT to its path.`, options);
    this.name = "GhostscriptNotFoundError";
  }
}

export class GhostscriptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Ghostscript did not finish within ${timeoutMs} ms`);
    this.name = "GhostscriptTimeoutError";
  }
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/** Runs Ghostscript with `args`. Resolves with the exit status and the last log lines; never uses a shell. */
export function runGhostscript(gs: GhostscriptCommand, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn(gs.command, [...(gs.prefixArgs ?? []), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? { PATH: process.env.PATH ?? "" },
      windowsHide: true,
    });
    const log: string[] = [];
    const collect = (chunk: Buffer): void => {
      log.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean));
      if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new GhostscriptTimeoutError(timeoutMs)));
    }, timeoutMs);
    const onAbort = (): void => {
      child.kill();
      finish(() => reject(options.signal?.reason ?? new Error("aborted")));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(() => reject(error.code === "ENOENT" ? new GhostscriptNotFoundError(gs.command, { cause: error }) : error));
    });
    child.once("close", (exitCode, signal) => finish(() => resolve({ exitCode, signal, log })));
  });
}

/** `gs --version`, or `undefined` when Ghostscript is not installed or does not answer. */
export async function detectVersion(gs: GhostscriptCommand, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const result = await runGhostscript(gs, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS, env });
    const version = result.log[0]?.trim();
    return result.exitCode === 0 && version && /^\d+(\.\d+)*/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}
