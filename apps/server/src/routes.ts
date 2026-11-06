import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SYSTEM_ACTOR, type Actor } from "@bax-print/core";
import type { CheckRegistry } from "@bax-print/inspect";
import { errorBody, errorResponse, invalid } from "./errors.js";
import { doc } from "./openapi.js";
import type { PreflightService } from "./preflight-service.js";
import type { ProfileService } from "./profiles.js";

/**
 * Spec 007 routes:
 * - `GET /preflight-checks`: the available checks, their rules and parameter schemas;
 * - `/preflight-profiles` CRUD (built-in profiles are read-only);
 * - `GET /jobs/:id/findings`, `POST /jobs/:id/inspect`;
 * - `PATCH /jobs/:id/edits` (reruns the edit-dependent checks);
 * - `POST /jobs/:id/preflight/override` (clears a preflight hold with a reason);
 * - `POST /jobs/:id/normalize` (FR3, optional).
 *
 * Errors use `{ error: { code, message, details? } }`.
 */

export interface RouteDeps {
  profiles: ProfileService;
  preflight: PreflightService;
  registry: CheckRegistry;
  /** Server-side fixup options per target, e.g. the output intent profile path. Clients never pass paths. */
  normalizationOptions?: Readonly<Record<string, Record<string, unknown>>>;
  /** The operator behind a request, recorded on the job's events. Default: the system actor. */
  authenticate?: (request: FastifyRequest) => Actor;
}

type IdParams = { Params: { id: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw invalid("Request body must be a JSON object");
  return body;
}

/** The server's one error handler and 404 handler; bodies come from `errorResponse`. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply: FastifyReply) => {
    const { statusCode, body } = errorResponse(error);
    if (statusCode >= 500) request.log.error({ err: error }, "request failed");
    return reply.code(statusCode).send(body);
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send(errorBody("not_found", `No route for ${request.method} ${request.url}`)));
}

/** Spec 052a: `GET /health`, always mounted and public (`PUBLIC_ROUTES`); it reads no store. */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get(
    "/health",
    { schema: doc({ operationId: "getHealth", summary: "Liveness check; reads no store", tags: ["health"], responseSchema: "Health" }) },
    async () => ({ status: "ok" }),
  );
}

export function registerPreflightRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { profiles, preflight, registry } = deps;
  const actorOf = (request: FastifyRequest): Actor => deps.authenticate?.(request) ?? SYSTEM_ACTOR;

  app.get("/preflight-checks", async () =>
    registry.list().map((check) => ({
      id: check.id,
      title: check.title,
      description: check.description,
      rules: check.rules,
      params: check.params,
    })),
  );

  app.get("/preflight-profiles", async () => profiles.list());

  app.get<IdParams>("/preflight-profiles/:id", async (request) => profiles.get(request.params.id));

  app.post("/preflight-profiles", async (request, reply) => {
    const created = await profiles.create(request.body);
    return reply.code(201).send(created);
  });

  app.put<IdParams>("/preflight-profiles/:id", async (request) => profiles.replace(request.params.id, request.body));

  app.delete<IdParams>("/preflight-profiles/:id", async (request, reply) => {
    await profiles.delete(request.params.id);
    return reply.code(204).send();
  });

  app.get<IdParams>("/jobs/:id/findings", async (request) => preflight.findings(request.params.id));

  app.post<IdParams>("/jobs/:id/inspect", async (request) => {
    const job = await preflight.inspectJob(request.params.id, actorOf(request));
    return preflight.findings(job.id);
  });

  app.patch<IdParams>("/jobs/:id/edits", async (request) => {
    const body = bodyRecord(request.body);
    if (!("edits" in body)) throw invalid('Request body needs "edits": the full, ordered edit list');
    const { job, report } = await preflight.updateEdits(request.params.id, body.edits, actorOf(request));
    return { jobId: job.id, status: job.status, ...(job.hold ? { hold: job.hold } : {}), edits: job.ticket.edits, report };
  });

  app.post<IdParams>("/jobs/:id/preflight/override", async (request) => {
    const body = bodyRecord(request.body);
    if (typeof body.reason !== "string") throw invalid('Request body needs "reason" (string)');
    const job = await preflight.clearHold(request.params.id, body.reason, actorOf(request));
    return { jobId: job.id, status: job.status };
  });

  app.post<IdParams>("/jobs/:id/normalize", async (request, reply) => {
    const body = bodyRecord(request.body);
    if (typeof body.target !== "string" || body.target.length === 0) throw invalid('Request body needs "target" (string)');
    const colorConversion = body.colorConversion;
    if (colorConversion !== undefined && colorConversion !== "CMYK" && colorConversion !== "RGB") {
      throw invalid('"colorConversion" must be "CMYK" or "RGB"');
    }
    const options = {
      ...deps.normalizationOptions?.[body.target],
      ...(colorConversion !== undefined ? { colorConversion } : {}),
    };
    const derived = await preflight.normalize(
      request.params.id,
      body.target,
      Object.keys(options).length > 0 ? options : undefined,
      actorOf(request),
    );
    return reply.code(201).send(derived);
  });
}
