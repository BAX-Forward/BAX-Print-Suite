import { createActorResolver, type ActorResolver, type ActorResolverFallback } from './actor-resolver.js';
import type { ApiTokenRouteOptions } from './api-token-routes.js';
import { createBearerTokenVerifier, type ApiTokenStore } from './bearer-token-verifier.js';

/**
 * Spec 029c: API tokens are opt-in. With BPS_API_TOKENS=1 and a job database (BPS_DATABASE) the
 * server mounts the `/api-tokens` routes and accepts bearer tokens; callers without one are still
 * the local admin unless BPS_AUTH_FALLBACK=deny. With neither set nothing changes.
 */

export const API_TOKENS_ENV = 'BPS_API_TOKENS';
export const AUTH_FALLBACK_ENV = 'BPS_AUTH_FALLBACK';

export type ApiTokenEnv = Readonly<Record<string, string | undefined>>;

export interface ApiTokenConfig {
  /** Present when tokens are enabled: the `ServerDeps.apiTokens` and `ServerDeps.authenticate` to use. */
  readonly enabled?: {
    readonly apiTokens: ApiTokenRouteOptions;
    readonly authenticate: ActorResolver;
    readonly fallback: ActorResolverFallback;
  };
}

/** Absent is off and `1` is on; any other value is a configuration error, never a guess. */
export function parseApiTokensFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${API_TOKENS_ENV} must be 1 or unset, got ${JSON.stringify(value)}`);
}

/** Absent is the local admin; only `local-admin` and `deny` are accepted. */
export function parseAuthFallback(value: string | undefined): ActorResolverFallback {
  if (value === undefined || value === 'local-admin') return 'local-admin';
  if (value === 'deny') return 'deny';
  throw new Error(`${AUTH_FALLBACK_ENV} must be deny, local-admin or unset, got ${JSON.stringify(value)}`);
}

/**
 * Reads the flags from `env`. `tokens` is the job database's token repository, or `undefined`
 * without BPS_DATABASE. Throws for an invalid flag, for tokens without a database, and for
 * BPS_AUTH_FALLBACK=deny without tokens, which would lock every caller out.
 */
export function configureApiTokens(env: ApiTokenEnv, tokens: ApiTokenStore | undefined, now?: () => Date): ApiTokenConfig {
  const enabled = parseApiTokensFlag(env[API_TOKENS_ENV]);
  const fallback = parseAuthFallback(env[AUTH_FALLBACK_ENV]);
  if (!enabled) {
    if (fallback === 'deny') throw new Error(`${AUTH_FALLBACK_ENV}=deny needs ${API_TOKENS_ENV}=1`);
    return {};
  }
  if (tokens === undefined) throw new Error(`${API_TOKENS_ENV}=1 needs a job database (set BPS_DATABASE)`);
  const options = { tokens, ...(now === undefined ? {} : { now }) };
  return {
    enabled: {
      apiTokens: options,
      authenticate: createActorResolver({ verifiers: [createBearerTokenVerifier(options)], fallback }),
      fallback,
    },
  };
}
