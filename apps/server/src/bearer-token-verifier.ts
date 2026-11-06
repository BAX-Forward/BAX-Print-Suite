import type { FastifyRequest } from 'fastify';
import {
  API_TOKEN_PREFIX,
  ROLE_PERMISSIONS,
  verifyApiToken,
  type Actor,
  type ApiTokenRecord,
  type Permission,
} from '@bax-print/core';
import type { SqliteApiTokenRepository } from '@bax-print/store';
import type { CredentialVerifier } from './actor-resolver.js';
import { unauthenticated } from './errors.js';
import { scopedActor } from './route-permissions.js';

/**
 * Spec 029c: an opt-in credential verifier for `Authorization: Bearer bps_...` API tokens (spec
 * 029a) stored in the job database (spec 029b). Any other request is not its business: it answers
 * `undefined` and the actor resolver moves on. A bearer token it cannot verify (unknown, wrong,
 * revoked, expired or malformed) is rejected with 401 `unauthenticated` and never falls back.
 */

/** The parts of the store's token repository the verifier and the token routes use. */
export type ApiTokenStore = Pick<SqliteApiTokenRepository, 'save' | 'get' | 'findByPrefix' | 'list' | 'revoke'>;

export interface BearerTokenVerifierOptions {
  readonly tokens: ApiTokenStore;
  /** Tests fix the time a token's expiry is checked against. */
  readonly now?: () => Date;
}

/** Core's lookup prefix: the first 8 characters of the secret after `bps_`. */
const LOOKUP_PREFIX_LENGTH = 8;

/** The auth scheme is case-insensitive (RFC 7235 §2.1); the token itself is not. */
const BEARER = /^bearer[ \t]+(.*)$/i;

/**
 * Roles a token actor may get, least first. The guard checks the token's scopes; the role is what
 * a handler that checks the role itself sees, so it is the least role holding every scope.
 */
const TOKEN_ROLES = ['viewer', 'operator', 'admin'] as const satisfies readonly Actor['role'][];

const REJECTED = 'The API token is not valid';

/** The presented `bps_` secret, or `undefined` when the request carries no bearer API token. */
function presentedSecret(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const credential = BEARER.exec(header)?.[1]?.trim();
  return credential?.startsWith(API_TOKEN_PREFIX) === true ? credential : undefined;
}

function roleFor(scopes: readonly Permission[]): Actor['role'] {
  const role = TOKEN_ROLES.find((candidate) => scopes.every((scope) => ROLE_PERMISSIONS[candidate].includes(scope)));
  return role ?? 'admin';
}

/** The actor of a verified token: its id names the token, its permissions are the token's scopes. */
export function tokenActor(record: ApiTokenRecord): Actor {
  return scopedActor({ id: `api-token:${record.id}`, role: roleFor(record.scopes) }, record.scopes);
}

export function createBearerTokenVerifier(options: BearerTokenVerifierOptions): CredentialVerifier {
  const { tokens } = options;
  const now = options.now ?? ((): Date => new Date());

  const actorFor = (request: FastifyRequest): Actor | undefined => {
    const secret = presentedSecret(request.headers.authorization);
    if (secret === undefined) return undefined;
    const prefix = secret.slice(API_TOKEN_PREFIX.length, API_TOKEN_PREFIX.length + LOOKUP_PREFIX_LENGTH);
    const at = now();
    // Every candidate is checked by core, which compares hashes in constant time.
    const record = tokens.findByPrefix(prefix).find((candidate) => verifyApiToken(secret, candidate, at).ok);
    if (record === undefined) throw unauthenticated(REJECTED);
    return tokenActor(record);
  };

  // A store failure rejects too, which the resolver answers with a 500 rather than the fallback.
  return { verify: (request) => Promise.resolve().then(() => actorFor(request)) };
}
