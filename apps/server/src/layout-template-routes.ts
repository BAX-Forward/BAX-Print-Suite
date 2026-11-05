import type { FastifyInstance } from 'fastify';
import type { LayoutTemplate, LayoutTemplateRepository, LayoutTemplateSummary } from '@bax-print/store';
import { notFound } from './errors.js';
import { doc } from './openapi.js';

export interface LayoutTemplateRouteDeps {
  /** The store package's `SqliteLayoutTemplateRepository` satisfies it. */
  readonly templates: LayoutTemplateRepository;
}

/** The request body of `POST /layout-templates`. */
export interface SaveLayoutTemplateBody {
  id?: string;
  name: string;
  rollWidthMm: number;
  layoutJson: string;
}

/** The request body of `PATCH /layout-templates/:id`. */
export interface RenameLayoutTemplateBody {
  name: string;
}

const ID_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } } };

/** Shapes only; the store checks the name, the roll width and the layout document (`layout_template_invalid`). */
const SAVE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'rollWidthMm', 'layoutJson'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    rollWidthMm: { type: 'number' },
    layoutJson: { type: 'string' },
  },
};

const RENAME_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: { type: 'string' } },
};

const INVALID = 'The name, roll width or layout document is invalid (`layout_template_invalid`, `details.field` names it)';
const NAME_EXISTS = 'Another template has the name (`layout_template_name_exists`)';

/** Spec 003x: HTTP routes over the Spec 003w saved layout templates. */
export function registerLayoutTemplateRoutes(app: FastifyInstance, deps: LayoutTemplateRouteDeps): void {
  const { templates } = deps;

  app.post<{ Body: SaveLayoutTemplateBody }>(
    '/layout-templates',
    {
      schema: doc({
        operationId: 'saveLayoutTemplate',
        summary: 'Saves a layout as a named template; saving an existing id replaces it and keeps its creation time',
        tags: ['layouts'],
        body: SAVE_BODY,
        responses: {
          201: 'The saved template',
          400: 'The body does not match the schema (`invalid_request`)',
          409: NAME_EXISTS,
          422: INVALID,
        },
        responseSchema: 'LayoutTemplate',
      }),
    },
    async (request, reply) => {
      const { id, name, rollWidthMm, layoutJson } = request.body;
      const saved = templates.save({ ...(id === undefined ? {} : { id }), name, rollWidthMm, layoutJson });
      return reply.status(201).send(saved);
    },
  );

  app.get(
    '/layout-templates',
    {
      schema: doc({
        operationId: 'listLayoutTemplates',
        summary: 'Lists the saved templates by name, without their layout documents',
        tags: ['layouts'],
        responses: { 200: 'The template summaries' },
        responseSchema: 'LayoutTemplateSummaryList',
      }),
    },
    async (): Promise<{ items: LayoutTemplateSummary[] }> => ({ items: templates.list() }),
  );

  app.get<{ Params: { id: string } }>(
    '/layout-templates/:id',
    {
      schema: doc({
        operationId: 'getLayoutTemplate',
        summary: 'Reads a saved template with its layout document',
        tags: ['layouts'],
        params: ID_PARAMS,
        responses: { 200: 'The template', 404: 'Unknown template (`not_found`)' },
        responseSchema: 'LayoutTemplate',
      }),
    },
    async (request): Promise<LayoutTemplate> => {
      const { id } = request.params;
      const template = templates.get(id);
      if (!template) throw notFound('Layout template', id);
      return template;
    },
  );

  app.patch<{ Params: { id: string }; Body: RenameLayoutTemplateBody }>(
    '/layout-templates/:id',
    {
      schema: doc({
        operationId: 'renameLayoutTemplate',
        summary: 'Renames a saved template',
        tags: ['layouts'],
        params: ID_PARAMS,
        body: RENAME_BODY,
        responses: {
          200: 'The renamed template',
          400: 'The body does not match the schema (`invalid_request`)',
          404: 'Unknown template (`not_found`)',
          409: NAME_EXISTS,
          422: INVALID,
        },
        responseSchema: 'LayoutTemplate',
      }),
    },
    async (request): Promise<LayoutTemplate> => {
      const { id } = request.params;
      // Checked first so an unknown id is a 404 even when the new name is taken.
      if (!templates.get(id)) throw notFound('Layout template', id);
      const renamed = templates.rename(id, request.body.name);
      if (!renamed) throw notFound('Layout template', id);
      return renamed;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/layout-templates/:id',
    {
      schema: doc({
        operationId: 'deleteLayoutTemplate',
        summary: 'Deletes a saved template',
        tags: ['layouts'],
        params: ID_PARAMS,
        responses: { 204: 'Deleted', 404: 'Unknown template (`not_found`)' },
      }),
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!templates.delete(id)) throw notFound('Layout template', id);
      return reply.status(204).send();
    },
  );
}
