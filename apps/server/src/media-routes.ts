import Fastify, { type FastifyInstance } from "fastify";
import { invalid } from "./errors.js";
import type { MediaService, MediumInput, OutputModeInput, PresetInput, ProfilingSessionInput } from "./media-service.js";
import type { Attributes } from "./media-stores.js";
import { doc, OpenApiCollector } from "./openapi.js";
import { registerErrorHandler } from "./routes.js";

/**
 * Spec 005 routes:
 * - `/media` CRUD and `POST /media/sync` (publishes `media.synced`);
 * - `GET|POST /media/:id/modes`;
 * - `GET|POST /color-setups/:id/revisions`, `POST /color-setups/:id/revisions/:revisionId/publish`
 *   (publishes `colorsetup.published`);
 * - `/presets` CRUD;
 * - `POST /profiling-sessions`, `GET /profiling-sessions/:id`,
 *   `POST /profiling-sessions/:id/steps/:stepId/complete` (publishes `profiling.step.completed`);
 * - `GET /openapi.json`, generated from the same schemas Fastify validates with.
 *
 * Errors use `{ error: { code, message, details? } }`.
 */

export interface MediaRouteDeps {
  readonly media: MediaService;
  /** Collects the documented routes; `GET /openapi.json` serves its document. */
  readonly openapi?: OpenApiCollector;
}

type IdParams = { Params: { id: string } };

const ID = { type: "string", minLength: 1 };
const NAME = { type: "string", minLength: 1 };
const OBJECT = { type: "object" };

const idParams = { type: "object", required: ["id"], properties: { id: ID } };

const mediumBody = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { id: ID, name: NAME, attributes: OBJECT },
};

const modeBody = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { id: ID, name: NAME, settings: OBJECT },
};

const syncBody = {
  type: "object",
  required: ["source", "media"],
  additionalProperties: false,
  properties: { source: NAME, media: { type: "array", items: { ...mediumBody, required: ["id", "name"] } } },
};

const revisionBody = {
  type: "object",
  required: ["settings"],
  additionalProperties: false,
  properties: { settings: OBJECT },
};

const presetBody = {
  type: "object",
  required: ["name", "mediumId", "colorSetupId"],
  additionalProperties: false,
  properties: { id: ID, name: NAME, mediumId: ID, outputModeId: ID, colorSetupId: ID },
};

const sessionBody = {
  type: "object",
  required: ["mediumId", "colorSetupId", "steps"],
  additionalProperties: false,
  properties: { mediumId: ID, outputModeId: ID, colorSetupId: ID, steps: { type: "array", minItems: 1, items: ID } },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The optional `{ result }` body of a step completion; no body means an empty result. */
function stepResult(body: unknown): Attributes {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) throw invalid("Request body must be a JSON object");
  if (body.result === undefined) return {};
  if (!isRecord(body.result)) throw invalid('"result" must be a JSON object');
  return body.result;
}

export function registerMediaRoutes(app: FastifyInstance, deps: MediaRouteDeps): void {
  const { media, openapi } = deps;
  if (openapi) {
    app.addHook("onRoute", (route) => openapi.add(route));
    app.get("/openapi.json", async () => openapi.document);
  }

  // --- media library ---

  app.get("/media", { schema: doc({ operationId: "listMedia", summary: "List media", tags: ["media"] }) }, async () => media.listMedia());

  app.post<{ Body: MediumInput }>(
    "/media",
    { schema: doc({ operationId: "createMedium", summary: "Add a medium", tags: ["media"], body: mediumBody, responses: { 201: "Created", 409: "Id in use" } }) },
    async (request, reply) => reply.code(201).send(await media.createMedium(request.body)),
  );

  app.post<{ Body: { source: string; media: MediumInput[] } }>(
    "/media/sync",
    { schema: doc({ operationId: "syncMedia", summary: "Upsert media reported by a source", tags: ["media"], body: syncBody }) },
    async (request) => media.syncMedia(request.body.source, request.body.media),
  );

  app.get<IdParams>(
    "/media/:id",
    { schema: doc({ operationId: "getMedium", summary: "Get a medium", tags: ["media"], params: idParams, responses: { 200: "OK", 404: "Not found" } }) },
    async (request) => media.getMedium(request.params.id),
  );

  app.put<IdParams & { Body: MediumInput }>(
    "/media/:id",
    { schema: doc({ operationId: "replaceMedium", summary: "Replace a medium", tags: ["media"], params: idParams, body: mediumBody }) },
    async (request) => media.replaceMedium(request.params.id, request.body),
  );

  app.delete<IdParams>(
    "/media/:id",
    { schema: doc({ operationId: "deleteMedium", summary: "Delete an unused medium", tags: ["media"], params: idParams, responses: { 204: "Deleted", 409: "Used by a preset" } }) },
    async (request, reply) => {
      await media.deleteMedium(request.params.id);
      return reply.code(204).send();
    },
  );

  app.get<IdParams>(
    "/media/:id/modes",
    { schema: doc({ operationId: "listOutputModes", summary: "List a medium's output modes", tags: ["media"], params: idParams }) },
    async (request) => media.listModes(request.params.id),
  );

  app.post<IdParams & { Body: OutputModeInput }>(
    "/media/:id/modes",
    { schema: doc({ operationId: "createOutputMode", summary: "Add an output mode", tags: ["media"], params: idParams, body: modeBody, responses: { 201: "Created" } }) },
    async (request, reply) => reply.code(201).send(await media.createMode(request.params.id, request.body)),
  );

  // --- color setup revisions ---

  app.get<IdParams>(
    "/color-setups/:id/revisions",
    { schema: doc({ operationId: "listColorSetupRevisions", summary: "List a color setup's revisions", tags: ["color-setups"], params: idParams }) },
    async (request) => media.listRevisions(request.params.id),
  );

  app.post<IdParams & { Body: { settings: Attributes } }>(
    "/color-setups/:id/revisions",
    { schema: doc({ operationId: "createColorSetupRevision", summary: "Add a draft revision", tags: ["color-setups"], params: idParams, body: revisionBody, responses: { 201: "Created" } }) },
    async (request, reply) => reply.code(201).send(await media.createRevision(request.params.id, request.body.settings)),
  );

  app.post<{ Params: { id: string; revisionId: string } }>(
    "/color-setups/:id/revisions/:revisionId/publish",
    {
      schema: doc({
        operationId: "publishColorSetupRevision",
        summary: "Publish a draft revision",
        tags: ["color-setups"],
        params: { type: "object", required: ["id", "revisionId"], properties: { id: ID, revisionId: ID } },
        responses: { 200: "OK", 404: "Not found", 409: "Not a draft" },
      }),
    },
    async (request) => media.publishRevision(request.params.id, request.params.revisionId),
  );

  // --- presets ---

  app.get("/presets", { schema: doc({ operationId: "listPresets", summary: "List presets", tags: ["presets"] }) }, async () => media.listPresets());

  app.post<{ Body: PresetInput }>(
    "/presets",
    { schema: doc({ operationId: "createPreset", summary: "Add a preset", tags: ["presets"], body: presetBody, responses: { 201: "Created", 409: "Id in use" } }) },
    async (request, reply) => reply.code(201).send(await media.createPreset(request.body)),
  );

  app.get<IdParams>(
    "/presets/:id",
    { schema: doc({ operationId: "getPreset", summary: "Get a preset", tags: ["presets"], params: idParams }) },
    async (request) => media.getPreset(request.params.id),
  );

  app.put<IdParams & { Body: PresetInput }>(
    "/presets/:id",
    { schema: doc({ operationId: "replacePreset", summary: "Replace a preset", tags: ["presets"], params: idParams, body: presetBody }) },
    async (request) => media.replacePreset(request.params.id, request.body),
  );

  app.delete<IdParams>(
    "/presets/:id",
    { schema: doc({ operationId: "deletePreset", summary: "Delete a preset", tags: ["presets"], params: idParams, responses: { 204: "Deleted" } }) },
    async (request, reply) => {
      await media.deletePreset(request.params.id);
      return reply.code(204).send();
    },
  );

  // --- profiling sessions ---

  app.post<{ Body: ProfilingSessionInput }>(
    "/profiling-sessions",
    { schema: doc({ operationId: "createProfilingSession", summary: "Start a profiling session", tags: ["profiling"], body: sessionBody, responses: { 201: "Created" } }) },
    async (request, reply) => reply.code(201).send(await media.createSession(request.body)),
  );

  app.get<IdParams>(
    "/profiling-sessions/:id",
    { schema: doc({ operationId: "getProfilingSession", summary: "Get a profiling session", tags: ["profiling"], params: idParams }) },
    async (request) => media.getSession(request.params.id),
  );

  app.post<{ Params: { id: string; stepId: string } }>(
    "/profiling-sessions/:id/steps/:stepId/complete",
    {
      schema: doc({
        operationId: "completeProfilingStep",
        summary: "Complete the next step of a session",
        tags: ["profiling"],
        params: { type: "object", required: ["id", "stepId"], properties: { id: ID, stepId: ID } },
        responses: { 200: "OK", 404: "Not found", 409: "Out of order" },
      }),
    },
    async (request) => media.completeStep(request.params.id, request.params.stepId, stepResult(request.body)),
  );
}

/** A standalone Spec 005 app: error handler, OpenAPI collector and the media routes. */
export function buildMediaServer(deps: { media: MediaService; version?: string; logger?: boolean }): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });
  registerErrorHandler(app);
  registerMediaRoutes(app, { media: deps.media, openapi: new OpenApiCollector(deps.version ?? "0.1.0") });
  return app;
}
