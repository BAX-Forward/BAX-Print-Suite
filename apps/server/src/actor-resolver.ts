import type { FastifyRequest } from 'fastify';
import type { Actor } from '@bax-print/core';
import { unauthenticated } from './errors.js';
import { LOCAL_ADMIN } from './route-permissions.js';

/**
 * Spec 028c: a pluggable actor resolver. Credential verifiers are tried in order; the first that
 * recognizes the caller names the actor. When none does, the explicit fallback decides: the local
 * admin (the single-PC default of Spec 024b) or a 401 `unauthenticated`. This module ships no
 * concrete verifier; deployments supply their own.
 */

/** Recognizes a caller from its request, or answers `undefined` when the request carries no credential it knows. */
export interface CredentialVerifier {
  /** Rejects when verification itself fails; the server answers 500 without the reason. */
  verify(request: FastifyRequest): Promise<Actor | undefined>;
}

/** What a request no verifier recognizes resolves to. */
export type ActorResolverFallback = 'local-admin' | 'deny';

export const ACTOR_RESOLVER_FALLBACKS: readonly ActorResolverFallback[] = ['local-admin', 'deny'];

export interface ActorResolverOptions {
  readonly verifiers: readonly CredentialVerifier[];
  readonly fallback: ActorResolverFallback;
}

/** Fits `ServerDeps.authenticate`. */
export type ActorResolver = (request: FastifyRequest) => Promise<Actor>;

function isFallback(value: unknown): value is ActorResolverFallback {
  return ACTOR_RESOLVER_FALLBACKS.some((fallback) => fallback === value);
}

export function createActorResolver(options: ActorResolverOptions): ActorResolver {
  // Checked at runtime too: a misspelled fallback must not silently become either choice.
  const { fallback } = options;
  if (isFallback(fallback)) return resolveWith([...options.verifiers], fallback);
  throw new TypeError(`fallback must be one of ${ACTOR_RESOLVER_FALLBACKS.join(', ')}`);
}

function resolveWith(verifiers: readonly CredentialVerifier[], fallback: ActorResolverFallback): ActorResolver {
  return async (request) => {
    // A verifier that rejects is not a miss: the request fails rather than fall through to the fallback.
    for (const verifier of verifiers) {
      const actor = await verifier.verify(request);
      if (actor !== undefined) return actor;
    }
    if (fallback === 'local-admin') return LOCAL_ADMIN;
    throw unauthenticated();
  };
}
