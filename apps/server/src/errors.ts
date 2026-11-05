import {
  ColorSetupMismatchError,
  ColorSetupNotFoundError,
  ColorSetupRequiredError,
  JobNotFoundError,
  PackageIntegrityError,
  RemapRequiredError,
} from "@bax-print/archive";
import {
  BpsError,
  ForbiddenError,
  IllegalTransitionError,
  InvalidArgumentError,
  InvalidFinishingTransitionError,
  InvalidLifecycleError,
  LegalHoldError,
} from "@bax-print/core";
import { InvalidCursorError, InvalidFinishingPlanError, InvalidLayoutTemplateError, LayoutTemplateNameConflictError } from "@bax-print/store";

/** Service errors with the HTTP status the API maps them to. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: readonly string[];

  constructor(statusCode: number, code: string, message: string, details?: readonly string[]) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string, id: string): HttpError => new HttpError(404, "not_found", `${what} ${id} not found`);

export const invalid = (message: string, details?: readonly string[]): HttpError => new HttpError(400, "invalid_request", message, details);

export const conflict = (message: string): HttpError => new HttpError(409, "conflict", message);

/** Spec 004a: proof watermark options the marks package rejects; `details` are its zod issues. */
export const proofWatermarkInvalid = (message: string, details: readonly string[]): HttpError =>
  new HttpError(422, "proof_watermark_invalid", message, details);

/** A list of problems (validation) or structured context (e.g. the ids an import must remap). */
export type ErrorDetails = readonly string[] | Readonly<Record<string, unknown>>;

/** The one error body every route answers with. */
export interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly details?: ErrorDetails };
}

export interface ErrorResponse {
  readonly statusCode: number;
  readonly body: ErrorBody;
}

/** Statuses of the core, store and archive errors; any other `BpsError` is a 400. */
const STATUS_BY_ERROR: readonly [new (...args: never[]) => BpsError, number][] = [
  [JobNotFoundError, 404],
  [ForbiddenError, 403],
  [InvalidLifecycleError, 409],
  [LegalHoldError, 409],
  [IllegalTransitionError, 409],
  [ColorSetupRequiredError, 422],
  [ColorSetupMismatchError, 422],
  [ColorSetupNotFoundError, 422],
  [PackageIntegrityError, 422],
  [RemapRequiredError, 422],
  [InvalidArgumentError, 400],
  [InvalidCursorError, 400],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmpty(details: ErrorDetails): boolean {
  return Array.isArray(details) ? details.length === 0 : Object.keys(details).length === 0;
}

export function errorBody(code: string, message: string, details?: ErrorDetails): ErrorBody {
  return { error: { code, message, ...(details && !isEmpty(details) ? { details } : {}) } };
}

function bpsStatus(error: BpsError): number {
  return STATUS_BY_ERROR.find(([type]) => error instanceof type)?.[1] ?? 400;
}

function bpsDetails(error: BpsError): ErrorDetails | undefined {
  if (error instanceof RemapRequiredError) {
    return { ...error.details, unknownDevices: error.unknownDevices, unknownMedia: error.unknownMedia };
  }
  return error.details;
}

/**
 * The status and `{ error: { code, message, details? } }` body for anything a route throws.
 * Fastify's own client errors (malformed JSON, schema validation, wrong content type, body too
 * large) are `invalid_request`; anything unexpected is a 500 whose message is not exposed.
 */
export function errorResponse(error: unknown): ErrorResponse {
  if (error instanceof HttpError) {
    return { statusCode: error.statusCode, body: errorBody(error.code, error.message, error.details) };
  }
  // Spec 004d: checked before the other core errors so the API's code is lowercase.
  if (error instanceof InvalidFinishingTransitionError) {
    return { statusCode: 409, body: errorBody("finishing_transition_invalid", error.message, error.details) };
  }
  if (error instanceof BpsError) {
    return { statusCode: bpsStatus(error), body: errorBody(error.code, error.message, bpsDetails(error)) };
  }
  // Spec 003x: the store's layout template errors keep their uppercase codes; the API's are lowercase.
  if (error instanceof InvalidLayoutTemplateError) {
    return { statusCode: 422, body: errorBody("layout_template_invalid", error.message, { field: error.field }) };
  }
  if (error instanceof LayoutTemplateNameConflictError) {
    return { statusCode: 409, body: errorBody("layout_template_name_exists", error.message, { name: error.templateName }) };
  }
  // Spec 004d: the store's finishing plan error keeps its uppercase code too.
  if (error instanceof InvalidFinishingPlanError) {
    return { statusCode: 422, body: errorBody("finishing_plan_invalid", error.message) };
  }
  const status = isRecord(error) && typeof error.statusCode === "number" ? error.statusCode : 500;
  if (status >= 400 && status < 500) {
    const message = error instanceof Error ? error.message : "Invalid request";
    return { statusCode: status, body: errorBody("invalid_request", message) };
  }
  return { statusCode: 500, body: errorBody("internal_error", "Internal server error") };
}
