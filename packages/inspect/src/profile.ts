import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { EditParseResult } from "@bax-print/core";
import { SeverityOrOffSchema, type CheckConfig, type Finding, type Severity } from "@bax-print/plugin-sdk";
import type { AnyCheck, RawFinding } from "./check.js";
import type { DocumentModel } from "./document-model.js";
import { RASTER_CHECKS } from "./raster-checks.js";
import type { RasterHeader } from "./raster-header.js";
import { BUILTIN_CHECKS, builtinRegistry, type CheckRegistry } from "./registry.js";
import { VECTOR_CHECKS } from "./vector-checks.js";
import type { VectorHeader } from "./vector-header.js";

/** Core's generic `{ ok, value } | { ok, errors }` result, used here for profiles and params. */
export type ProfileParseResult<T> = EditParseResult<T>;

/**
 * Preflight profile (Spec 007 FR2), our own JSON schema: the checks to run, their thresholds
 * (`params`) and a severity per rule. Profiles bind to hot folders or are chosen per job.
 */

export const PROFILE_SCHEMA_VERSION = 1;
export const PROFILE_ID_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";
const MAX_MESSAGE_LENGTH = 2000;
const MAX_ERRORS_PER_ITEM = 5;

export const ProfileCheckSchema = Type.Object(
  {
    check: Type.String({ minLength: 1, maxLength: 64 }),
    /** Default true. */
    enabled: Type.Optional(Type.Boolean()),
    /** Rule id → severity; `off` drops the rule. Rules not listed keep their default. */
    severity: Type.Optional(Type.Record(Type.String(), SeverityOrOffSchema)),
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const PreflightProfileSchema = Type.Object(
  {
    schemaVersion: Type.Literal(PROFILE_SCHEMA_VERSION),
    id: Type.String({ pattern: PROFILE_ID_PATTERN }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    checks: Type.Array(ProfileCheckSchema, { maxItems: 100 }),
  },
  { additionalProperties: false },
);

export type ProfileCheck = Static<typeof ProfileCheckSchema>;
export type PreflightProfile = Static<typeof PreflightProfileSchema>;

/**
 * Every built-in check with its default rules and thresholds:
 * - effective resolution warn below 100 ppi, error below 50 ppi at final size (wide-format work
 *   is typically viewed from 1 m or more, where about 100 ppi is near the eye's resolving limit
 *   and 50 ppi shows visible pixelation);
 * - a font that is not embedded is an error, because output becomes unpredictable;
 * - a missing TrimBox is a warning, and the MediaBox is used.
 */
export const DEFAULT_PROFILE: PreflightProfile = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  id: "default",
  name: "Default",
  description: "All built-in checks with their default thresholds.",
  checks: BUILTIN_CHECKS.map((check) => ({ check: check.id })),
};

/**
 * Starting points for different work, not defaults. Fine art is seen up close (about 0.5 m), so
 * the resolution thresholds are higher; vehicle wraps are seen from several metres.
 */
export const EXAMPLE_PROFILES: readonly PreflightProfile[] = [
  {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    id: "fine-art",
    name: "Fine art",
    description: "Close viewing distance: stricter image resolution; transparency and overprint flagged for review.",
    checks: BUILTIN_CHECKS.map((check): ProfileCheck => {
      if (check.id === "image-resolution") return { check: check.id, params: { warnBelowPpi: 200, errorBelowPpi: 120 } };
      if (check.id === "transparency-overprint") return { check: check.id, severity: { overprint: "warn" } };
      return { check: check.id };
    }),
  },
  {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    id: "vehicle-wrap",
    name: "Vehicle wrap",
    description: "Viewed from several metres: lower resolution thresholds; a missing cut contour is a warning.",
    checks: BUILTIN_CHECKS.map((check): ProfileCheck => {
      if (check.id === "image-resolution") return { check: check.id, params: { warnBelowPpi: 60, errorBelowPpi: 30 } };
      if (check.id === "color-spaces") return { check: check.id, severity: { "cut-contour-missing": "warn" } };
      return { check: check.id };
    }),
  },
];

/** Applies the check's parameter defaults and validates the result. */
export function resolveParams(check: AnyCheck, input: Record<string, unknown> | undefined): ProfileParseResult<Record<string, unknown>> {
  const known = new Set(Object.keys(check.params.properties));
  const unknown = Object.keys(input ?? {}).filter((key) => !known.has(key));
  if (unknown.length > 0) return { ok: false, errors: unknown.map((key) => `unknown parameter "${key}"`) };
  const value = Value.Default(check.params, structuredClone(input ?? {})) as Record<string, unknown>;
  if (!Value.Check(check.params, value)) {
    const errors = [...Value.Errors(check.params, value)].slice(0, MAX_ERRORS_PER_ITEM).map((e) => `params${e.path}: ${e.message}`);
    return { ok: false, errors };
  }
  const errors = check.validateParams?.(value) ?? [];
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

function checkConfigErrors(entry: ProfileCheck, registry: CheckRegistry, at: string): string[] {
  const check = registry.get(entry.check);
  if (!check) return [`${at}: unknown check "${entry.check}"`];
  const errors = Object.keys(entry.severity ?? {})
    .filter((rule) => !Object.hasOwn(check.rules, rule))
    .map((rule) => `${at}: check "${entry.check}" has no rule "${rule}"`);
  const params = resolveParams(check, entry.params);
  if (!params.ok) errors.push(...params.errors.map((e) => `${at}: ${e}`));
  return errors;
}

export function validateProfile(input: unknown, registry: CheckRegistry = builtinRegistry()): ProfileParseResult<PreflightProfile> {
  if (!Value.Check(PreflightProfileSchema, input)) {
    const errors = [...Value.Errors(PreflightProfileSchema, input)].slice(0, 20).map((e) => `profile${e.path}: ${e.message}`);
    return { ok: false, errors };
  }
  const profile = input as PreflightProfile;
  const errors: string[] = [];
  const seen = new Set<string>();
  profile.checks.forEach((entry, index) => {
    const at = `checks[${index}]`;
    if (seen.has(entry.check)) errors.push(`${at}: check "${entry.check}" is listed twice`);
    seen.add(entry.check);
    errors.push(...checkConfigErrors(entry, registry, at));
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: profile };
}

/** The `Inspector/1` request form of a profile: enabled checks only. */
export function profileToChecks(profile: PreflightProfile): Record<string, CheckConfig> {
  const checks: Record<string, CheckConfig> = {};
  for (const entry of profile.checks) {
    if (entry.enabled === false) continue;
    checks[entry.check] = { severity: entry.severity, params: entry.params };
  }
  return checks;
}

function truncate(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : message;
}

function toFinding(checkId: string, severity: Severity, raw: RawFinding): Finding {
  return {
    checkId,
    severity,
    ...(raw.page !== undefined ? { page: raw.page } : {}),
    ...(raw.objectRef !== undefined ? { objectRef: raw.objectRef } : {}),
    message: truncate(raw.message),
    data: { ...raw.data, rule: raw.rule },
  };
}

function runCheck(check: AnyCheck, config: CheckConfig, run: (params: Record<string, unknown>) => RawFinding[]): Finding[] {
  const params = resolveParams(check, config.params);
  if (!params.ok) {
    return [toFinding(check.id, "error", { rule: "invalid-params", message: `Check ${check.id}: ${params.errors.join("; ")}` })];
  }
  let raw: RawFinding[];
  try {
    raw = run(params.value);
  } catch (error) {
    // A failing check must not let a job through unseen.
    return [toFinding(check.id, "error", { rule: "check-failed", message: `Check ${check.id} failed: ${(error as Error).message}` })];
  }
  return raw.flatMap((finding) => {
    const severity = config.severity?.[finding.rule] ?? check.rules[finding.rule]?.defaultSeverity ?? "warn";
    return severity === "off" ? [] : [toFinding(check.id, severity, finding)];
  });
}

/**
 * Runs the configured checks (all registered checks with defaults when `checks` is absent),
 * in registry order, and maps each rule to its severity.
 */
export function evaluateChecks(
  doc: DocumentModel,
  checks: Readonly<Record<string, CheckConfig>> | undefined,
  registry: CheckRegistry = builtinRegistry(),
): Finding[] {
  const configs: Record<string, CheckConfig> = checks ? { ...checks } : Object.fromEntries(registry.list().map((c) => [c.id, {}]));
  const findings: Finding[] = [];
  for (const check of registry.list()) {
    const config = configs[check.id];
    if (!config || config.enabled === false) continue;
    findings.push(...runCheck(check, config, (params) => check.run(doc, params)));
  }
  findings.push(...unknownCheckFindings(configs, registry));
  return findings;
}

function unknownCheckFindings(configs: Readonly<Record<string, CheckConfig>>, registry: CheckRegistry): Finding[] {
  return Object.keys(configs)
    .filter((id) => registry.has(id) === false)
    .map((id) => toFinding(id, "warn", { rule: "unknown-check", message: `Check ${id} is not available in this inspector` }));
}

/**
 * The raster form of `evaluateChecks` (Spec 031b): runs the configured raster checks on a
 * PNG, JPEG or TIFF header, with the same defaults, params, severities and unknown-check
 * findings. Registered checks without a raster form (the PDF checks) do not apply and are skipped.
 */
export function evaluateRasterChecks(
  header: RasterHeader,
  checks: Readonly<Record<string, CheckConfig>> | undefined,
  registry: CheckRegistry = builtinRegistry(),
): Finding[] {
  const configs: Record<string, CheckConfig> = checks ? { ...checks } : Object.fromEntries(registry.list().map((c) => [c.id, {}]));
  const findings: Finding[] = [];
  for (const check of registry.list()) {
    const config = configs[check.id];
    const raster = RASTER_CHECKS.find((candidate) => candidate.check === check);
    if (config === undefined || config.enabled === false || raster === undefined) continue;
    findings.push(...runCheck(check, config, (params) => raster.run(header, params)));
  }
  findings.push(...unknownCheckFindings(configs, registry));
  return findings;
}

/**
 * The vector form of `evaluateChecks` (Spec 035b): runs the configured vector checks (Spec 035a)
 * on an SVG or DXF header, like {@link evaluateRasterChecks} does for raster headers. Registered
 * checks without a vector form (the PDF and raster checks) do not apply and are skipped.
 */
export function evaluateVectorChecks(
  header: VectorHeader,
  checks: Readonly<Record<string, CheckConfig>> | undefined,
  registry: CheckRegistry = builtinRegistry(),
): Finding[] {
  const configs: Record<string, CheckConfig> = checks ? { ...checks } : Object.fromEntries(registry.list().map((c) => [c.id, {}]));
  const findings: Finding[] = [];
  for (const check of registry.list()) {
    const config = configs[check.id];
    const vector = VECTOR_CHECKS.find((candidate) => candidate.check === check);
    if (config === undefined || config.enabled === false || vector === undefined) continue;
    findings.push(...runCheck(check, config, (params) => vector.run(header, params)));
  }
  findings.push(...unknownCheckFindings(configs, registry));
  return findings;
}
