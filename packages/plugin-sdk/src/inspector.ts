import { Type, type Static } from "@sinclair/typebox";

/**
 * `Inspector/1` (ARCHITECTURE §3.3, Spec 007). The types are the TypeScript view of the
 * JSON Schemas below; the schemas are the contract for plugins in other languages.
 *
 * Large data never travels inline: documents are passed by handle (a path in a
 * host-owned spool directory), and `fixup()` returns a handle to a new file.
 */

export const INSPECTOR_INTERFACE = "Inspector";
export const INSPECTOR_INTERFACE_VERSION = "1.0.0";

export const SEVERITIES = ["info", "warn", "error"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SeveritySchema = Type.Union(SEVERITIES.map((s) => Type.Literal(s)));
/** A profile may also switch a rule off. */
export const SeverityOrOffSchema = Type.Union([...SEVERITIES, "off" as const].map((s) => Type.Literal(s)));
export type SeverityOrOff = Severity | "off";

export const FindingSchema = Type.Object({
  /** Id of the check that produced the finding, e.g. `image-resolution`. */
  checkId: Type.String({ minLength: 1, maxLength: 64 }),
  severity: SeveritySchema,
  /** Zero-based page index; absent for document-level findings. */
  page: Type.Optional(Type.Integer({ minimum: 0 })),
  /** Indirect object reference, e.g. `12 0 R`, when the finding concerns one object. */
  objectRef: Type.Optional(Type.String({ maxLength: 64 })),
  message: Type.String({ maxLength: 2000 }),
  /** Check-specific detail. `data.rule` names the rule within the check that fired. */
  data: Type.Record(Type.String(), Type.Unknown()),
});
export type Finding = Static<typeof FindingSchema>;

export const DocumentHandleSchema = Type.Object({
  kind: Type.Literal("file"),
  path: Type.String({ minLength: 1 }),
  sha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
  bytes: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type DocumentHandle = Static<typeof DocumentHandleSchema>;

/** Per-check settings taken from a preflight profile. */
export const CheckConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    /** Severity per rule id; `off` drops the rule's findings. */
    severity: Type.Optional(Type.Record(Type.String(), SeverityOrOffSchema)),
    /** Thresholds and options; each check documents and validates its own. */
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type CheckConfig = Static<typeof CheckConfigSchema>;

export const InspectContextSchema = Type.Object({
  /** `JobTicket.edits`; geometry-dependent checks evaluate the edited result. */
  edits: Type.Optional(Type.Array(Type.Unknown())),
  /** Printable width of the target medium. */
  printableWidthMm: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  /** Cut-contour spot names configured for the job (Spec 004 `CutConfig.spotNames`). */
  cutSpotNames: Type.Optional(Type.Array(Type.String())),
});
export type InspectContext = Static<typeof InspectContextSchema>;

export const InspectRequestSchema = Type.Object({
  document: DocumentHandleSchema,
  profileId: Type.Optional(Type.String()),
  /** Check id → settings. Checks not listed are not run. Absent means the inspector's defaults. */
  checks: Type.Optional(Type.Record(Type.String(), CheckConfigSchema)),
  context: Type.Optional(InspectContextSchema),
});
export type InspectRequest = Static<typeof InspectRequestSchema>;

export const ConformanceClaimSchema = Type.Object({
  family: Type.Union([Type.Literal("PDF/X"), Type.Literal("PDF/A")]),
  /** The claimed version exactly as written, e.g. `PDF/X-1a:2001` or `PDF/A-2b`. */
  claim: Type.String(),
  /** `pass` when the version keys and required entries are present. Not full validation. */
  structural: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
  missing: Type.Array(Type.String()),
});
export type ConformanceClaim = Static<typeof ConformanceClaimSchema>;

export const PreflightReportSchema = Type.Object({
  inspector: Type.Object({ id: Type.String(), version: Type.String() }),
  profileId: Type.Optional(Type.String()),
  generatedAt: Type.String(),
  pageCount: Type.Integer({ minimum: 0 }),
  findings: Type.Array(FindingSchema),
  summary: Type.Object({
    info: Type.Integer({ minimum: 0 }),
    warn: Type.Integer({ minimum: 0 }),
    error: Type.Integer({ minimum: 0 }),
  }),
  conformance: Type.Array(ConformanceClaimSchema),
});
export type PreflightReport = Static<typeof PreflightReportSchema>;

export const FixupRequestSchema = Type.Object({
  document: DocumentHandleSchema,
  /** One of the inspector's advertised `fixupTargets`, e.g. `PDF/X-3:2002`. */
  target: Type.String({ minLength: 1 }),
  /** Host-owned directory for the new file. The source document is never modified. */
  outputDir: Type.String({ minLength: 1 }),
  options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type FixupRequest = Static<typeof FixupRequestSchema>;

export const FixupResultSchema = Type.Object({
  /** Handle to the newly written file. */
  document: DocumentHandleSchema,
  target: Type.String(),
  log: Type.Array(Type.String()),
});
export type FixupResult = Static<typeof FixupResultSchema>;

export interface Inspector {
  readonly id: string;
  readonly version: string;
  inspect(request: InspectRequest, signal?: AbortSignal): Promise<PreflightReport>;
  /** Targets `fixup()` accepts. Absent or empty when the inspector has no fixup. */
  readonly fixupTargets?: readonly string[];
  fixup?(request: FixupRequest, signal?: AbortSignal): Promise<FixupResult>;
}

/** JSON Schemas of `Inspector/1`, for bindings in other languages. */
export const INSPECTOR_SCHEMAS = {
  Finding: FindingSchema,
  DocumentHandle: DocumentHandleSchema,
  CheckConfig: CheckConfigSchema,
  InspectContext: InspectContextSchema,
  InspectRequest: InspectRequestSchema,
  ConformanceClaim: ConformanceClaimSchema,
  PreflightReport: PreflightReportSchema,
  FixupRequest: FixupRequestSchema,
  FixupResult: FixupResultSchema,
} as const;

export function summarize(findings: readonly Finding[]): PreflightReport["summary"] {
  const summary = { info: 0, warn: 0, error: 0 };
  for (const finding of findings) summary[finding.severity] += 1;
  return summary;
}
