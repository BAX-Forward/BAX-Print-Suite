import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { parseEdits } from "@bax-print/core";
import {
  summarize,
  type CheckConfig,
  type Finding,
  type InspectContext,
  type InspectRequest,
  type Inspector,
  type PreflightReport,
} from "@bax-print/plugin-sdk";
import { conformanceClaims } from "./checks/conformance.js";
import { UnreadablePdfError, loadDocumentModel, type DocumentModel, type PreflightContext } from "./document-model.js";
import { evaluateChecks } from "./profile.js";
import { builtinRegistry, type CheckRegistry } from "./registry.js";

/** The built-in `Inspector/1` implementation over pdf-lib. Apache-2.0 code, so it may run in-process (ADR-0003). */

export const BUILTIN_INSPECTOR_ID = "org.bax-print.inspect.builtin";
export const BUILTIN_INSPECTOR_VERSION = "0.1.0";
/** pdf-lib parses the whole file in memory; larger inputs are refused rather than exhausting the host. */
export const MAX_INPUT_BYTES = 1536 * 1024 * 1024;

export class InputTooLargeError extends Error {
  constructor(bytes: number) {
    super(`File is ${bytes} bytes; the built-in inspector reads at most ${MAX_INPUT_BYTES} bytes`);
    this.name = "InputTooLargeError";
  }
}

export class DocumentHashMismatchError extends Error {
  constructor(path: string) {
    super(`File ${path} does not match the sha256 in its handle`);
    this.name = "DocumentHashMismatchError";
  }
}

export interface InspectBytesOptions {
  profileId?: string;
  /** Check id → settings. Absent runs every registered check with defaults. */
  checks?: Readonly<Record<string, CheckConfig>>;
  context?: PreflightContext;
  registry?: CheckRegistry;
  now?: () => Date;
}

function report(options: InspectBytesOptions, pageCount: number, findings: Finding[], doc?: DocumentModel): PreflightReport {
  return {
    inspector: { id: BUILTIN_INSPECTOR_ID, version: BUILTIN_INSPECTOR_VERSION },
    ...(options.profileId !== undefined ? { profileId: options.profileId } : {}),
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    pageCount,
    findings,
    summary: summarize(findings),
    conformance: doc ? conformanceClaims(doc) : [],
  };
}

/** Inspects PDF bytes. An unreadable file yields an error finding, never an exception. */
export async function inspectBytes(bytes: Uint8Array, options: InspectBytesOptions = {}): Promise<PreflightReport> {
  try {
    const doc = await loadDocumentModel(bytes, options.context ?? {});
    return report(options, doc.pageCount, evaluateChecks(doc, options.checks, options.registry ?? builtinRegistry()), doc);
  } catch (error) {
    if (!(error instanceof UnreadablePdfError)) throw error;
    // Severity is fixed: a file that can't be read must never pass preflight.
    return report(options, 0, [{ checkId: "document", severity: "error", message: error.message, data: { rule: "unreadable-pdf" } }]);
  }
}

/** Validates the wire form of the inspect context. Invalid edits become an error finding. */
export function contextFromRequest(context: InspectContext | undefined): { context: PreflightContext; findings: Finding[] } {
  const parsed = parseEdits(context?.edits ?? []);
  const findings: Finding[] = parsed.ok
    ? []
    : [
        {
          checkId: "document",
          severity: "error",
          message: `The job's edits are invalid: ${parsed.errors.join("; ")}`.slice(0, 2000),
          data: { rule: "invalid-edits", errors: parsed.errors },
        },
      ];
  return {
    context: {
      edits: parsed.ok ? parsed.value : [],
      printableWidthMm: context?.printableWidthMm,
      cutSpotNames: context?.cutSpotNames,
    },
    findings,
  };
}

async function readDocument(path: string, expectedSha256: string | undefined, signal?: AbortSignal): Promise<Uint8Array> {
  const info = await stat(path);
  if (info.size > MAX_INPUT_BYTES) throw new InputTooLargeError(info.size);
  const bytes: Uint8Array = await readFile(path, { signal });
  if (expectedSha256 && createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new DocumentHashMismatchError(path);
  }
  return bytes;
}

export interface BuiltinInspectorOptions {
  registry?: CheckRegistry;
  now?: () => Date;
}

export class BuiltinInspector implements Inspector {
  readonly id = BUILTIN_INSPECTOR_ID;
  readonly version = BUILTIN_INSPECTOR_VERSION;
  readonly fixupTargets: readonly string[] = [];
  private readonly options: BuiltinInspectorOptions;

  constructor(options: BuiltinInspectorOptions = {}) {
    this.options = options;
  }

  async inspect(request: InspectRequest, signal?: AbortSignal): Promise<PreflightReport> {
    signal?.throwIfAborted();
    const bytes = await readDocument(request.document.path, request.document.sha256, signal);
    signal?.throwIfAborted();
    const { context, findings: contextFindings } = contextFromRequest(request.context);
    const result = await inspectBytes(bytes, {
      profileId: request.profileId,
      checks: request.checks,
      context,
      registry: this.options.registry,
      now: this.options.now,
    });
    if (contextFindings.length === 0) return result;
    const findings = [...contextFindings, ...result.findings];
    return { ...result, findings, summary: summarize(findings) };
  }
}
