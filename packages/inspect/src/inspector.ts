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
import { evaluateChecks, evaluateRasterChecks, evaluateVectorChecks } from "./profile.js";
import { RasterHeaderError, readRasterHeader, sniffRasterType } from "./raster-header.js";
import { builtinRegistry, type CheckRegistry } from "./registry.js";
import { readVectorHeader } from "./vector-header.js";

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

/**
 * Inspects a PNG, JPEG or TIFF from its header alone (Spec 031b): one page, no conformance
 * claims. `undefined` when the bytes are not a raster format, so the caller reads them as PDF.
 */
function inspectRaster(bytes: Uint8Array, options: InspectBytesOptions): PreflightReport | undefined {
  try {
    const header = readRasterHeader(bytes);
    return report(options, 1, evaluateRasterChecks(header, options.checks, options.registry ?? builtinRegistry()));
  } catch (error) {
    if (error instanceof RasterHeaderError) return error.code === "UNKNOWN_FORMAT" ? undefined : unreadableRaster(options, error);
    throw error;
  }
}

function unreadableRaster(options: InspectBytesOptions, error: RasterHeaderError): PreflightReport {
  // Severity is fixed, as for an unreadable PDF.
  return report(options, 0, [
    { checkId: "document", severity: "error", message: error.message, data: { rule: "unreadable-raster", code: error.code } },
  ]);
}

/**
 * Inspects an SVG or ASCII DXF from its header alone (Spec 035b): one page, no conformance
 * claims. Nothing the SVG declares or references is expanded or fetched. `undefined` when the
 * bytes are not a vector format, so the caller reads them as PDF.
 */
function inspectVector(bytes: Uint8Array, options: InspectBytesOptions): PreflightReport | undefined {
  const header = readVectorHeader(bytes);
  if (header.kind === "error") {
    if (header.format === undefined) return undefined;
    // Recognised as SVG or DXF but not readable; severity is fixed, as for an unreadable PDF.
    return report(options, 0, [
      { checkId: "document", severity: "error", message: header.message, data: { rule: "unreadable-vector", code: header.code } },
    ]);
  }
  return report(options, 1, evaluateVectorChecks(header, options.checks, options.registry ?? builtinRegistry()));
}

/** Inspects PDF, PNG, JPEG, TIFF, SVG or DXF bytes. An unreadable file yields an error finding, never an exception. */
export async function inspectBytes(bytes: Uint8Array, options: InspectBytesOptions = {}): Promise<PreflightReport> {
  const raster = sniffRasterType(bytes) === undefined ? undefined : inspectRaster(bytes, options);
  if (raster) return raster;
  const vector = inspectVector(bytes, options);
  if (vector) return vector;
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
