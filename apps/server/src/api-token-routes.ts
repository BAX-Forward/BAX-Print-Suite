import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ForbiddenError,
  InvalidArgumentError,
  issueApiToken,
  parsePermission,
  type Actor,
  type ApiTokenRecord,
  type IssueApiTokenInput,
  type Permission,
} from '@bax-print/core';
import type { ApiTokenStore } from './bearer-token-verifier.js';
import { notFound } from './errors.js';
import { doc } from './openapi.js';
import { permissionsOf } from './route-permissions.js';

/**
 * Spec 029c: issue, list and revoke API tokens. The secret is answered once, by `POST /api-tokens`;
 * the store keeps only its hash and no other route returns it. A caller may only issue scopes it
 * holds itself, so a token can never mint a broader one.
 */

export interface ApiTokenRouteOptions {
  readonly tokens: ApiTokenStore;
  /** Tests fix the issue and revocation times. */
  readonly now?: () => Date;
}

interface Options extends ApiTokenRouteOptions {
  readonly authenticate: (request: FastifyRequest) => Actor;
}

/** A token as the API answers it: the record without its secret hash. */
export interface PublicApiToken {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly Permission[];
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
}

const ID_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } } };

const ISSUE_BODY = {
  type: 'object',
  required: ['name', 'scopes'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    scopes: { type: 'array', minItems: 1, items: { type: 'string' } },
    expiresAt: { type: 'string', format: 'date-time' },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function publicApiToken(record: ApiTokenRecord): PublicApiToken {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    scopes: record.scopes,
    createdAt: record.createdAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  };
}

/** Checks the body's types; core checks the name length, empty scopes and that the expiry is later than now. */
function parseIssueBody(body: unknown, now: Date): IssueApiTokenInput {
  if (!isRecord(body)) throw new InvalidArgumentError('send a JSON object with name and scopes');
  const { name, scopes, expiresAt } = body;
  if (typeof name !== 'string') throw new InvalidArgumentError('token name must be a string');
  if (!Array.isArray(scopes)) throw new InvalidArgumentError('token scopes must be an array');
  if (expiresAt !== undefined && typeof expiresAt !== 'string') {
    throw new InvalidArgumentError('expiresAt must be an ISO 8601 date-time');
  }
  return {
    name,
    scopes: scopes.map((scope: unknown) => parsePermission(scope)),
    now,
    ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt) }),
  };
}

export function registerApiTokenRoutes(app: FastifyInstance, options: Options): void {
  const { tokens, authenticate } = options;
  const now = options.now ?? ((): Date => new Date());

  app.post(
    '/api-tokens',
    {
      schema: doc({
        operationId: 'issueApiToken',
        summary: 'Issue an API token; the secret is answered only this once',
        tags: ['api-tokens'],
        bodyDoc: ISSUE_BODY,
        responses: {
          201: 'Issued',
          400: 'The name, scopes or expiry are invalid',
          403: 'The caller lacks `webhooks:write` or one of the requested scopes (`forbidden`, `details.permission` names it)',
        },
        responseSchema: 'IssuedApiToken',
      }),
    },
    (request, reply) => {
      const input = parseIssueBody(request.body, now());
      const held = permissionsOf(authenticate(request));
      const missing = input.scopes.find((scope) => !held.includes(scope));
      if (missing !== undefined) throw new ForbiddenError('POST /api-tokens', { permission: missing });
      const issued = issueApiToken(input);
      const record = tokens.save(issued.record);
      reply.code(201);
      return { token: publicApiToken(record), secret: issued.secret };
    },
  );

  app.get(
    '/api-tokens',
    {
      schema: doc({
        operationId: 'listApiTokens',
        summary: 'List API tokens, oldest first, without their secrets',
        tags: ['api-tokens'],
        responseSchema: 'ApiTokenList',
      }),
    },
    () => ({ items: tokens.list().map((record) => publicApiToken(record)) }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api-tokens/:id',
    {
      schema: doc({
        operationId: 'revokeApiToken',
        summary: 'Revoke an API token; revoking twice keeps the first time',
        tags: ['api-tokens'],
        params: ID_PARAMS,
        responses: { 200: 'Revoked', 404: 'No such token' },
        responseSchema: 'ApiTokenEnvelope',
      }),
    },
    (request) => {
      const { id } = request.params;
      const record = tokens.revoke(id, now()) ? tokens.get(id) : undefined;
      if (record === undefined) throw notFound('API token', id);
      return { token: publicApiToken(record) };
    },
  );
}
