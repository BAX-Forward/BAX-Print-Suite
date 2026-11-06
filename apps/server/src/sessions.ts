import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { accountToActor, type Actor } from '@bax-print/core';
import type { UserRepository } from '@bax-print/store';
import { createActorResolver, type ActorResolver, type CredentialVerifier } from './actor-resolver.js';

/**
 * Spec 028d: login sessions. A session token is 32 random bytes in base64url; only its SHA-256 is
 * kept. Sessions live in memory in this slice: a restart signs everyone out and server processes do
 * not share them. There is no session table and no migration.
 */

export const SESSION_COOKIE = 'bps_session';
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;
/** 32 bytes in unpadded base64url; anything else is never looked up. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BEARER_PATTERN = /^Bearer[ \t]+(\S+)[ \t]*$/i;
const COOKIE_ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Lax';

export interface Session {
  readonly userId: string;
  /** ISO 8601 timestamp. */
  readonly expiresAt: string;
}

/** A new session with its token, which is not kept and cannot be read back. */
export interface IssuedSession extends Session {
  readonly token: string;
}

interface StoredSession {
  readonly userId: string;
  readonly expiresAtMs: number;
}

export interface MemorySessionStoreOptions {
  /** Defaults to `DEFAULT_SESSION_TTL_MS`. */
  readonly ttlMs?: number;
  readonly now?: () => Date;
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Sessions keyed by the SHA-256 of their token. Expired sessions are dropped on lookup and on create. */
export class MemorySessionStore {
  readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly sessions = new Map<string, StoredSession>();

  constructor(options: MemorySessionStoreOptions = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    if (Number.isInteger(ttlMs) === false || ttlMs <= 0) {
      throw new RangeError('ttlMs must be a positive integer');
    }
    this.ttlMs = ttlMs;
    this.now = options.now ?? ((): Date => new Date());
  }

  create(userId: string): IssuedSession {
    const nowMs = this.now().getTime();
    this.sweep(nowMs);
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAtMs = nowMs + this.ttlMs;
    this.sessions.set(hashSessionToken(token), { userId, expiresAtMs });
    return { token, userId, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  find(token: string): Session | undefined {
    const key = hashSessionToken(token);
    const stored = this.sessions.get(key);
    if (stored === undefined) return undefined;
    if (stored.expiresAtMs <= this.now().getTime()) {
      this.sessions.delete(key);
      return undefined;
    }
    return { userId: stored.userId, expiresAt: new Date(stored.expiresAtMs).toISOString() };
  }

  revoke(token: string): boolean {
    return this.sessions.delete(hashSessionToken(token));
  }

  private sweep(nowMs: number): void {
    for (const [key, stored] of this.sessions) {
      if (stored.expiresAtMs <= nowMs) this.sessions.delete(key);
    }
  }
}

function bearerTokens(header: string | undefined): readonly string[] {
  const token = header === undefined ? undefined : BEARER_PATTERN.exec(header)?.[1];
  return token === undefined ? [] : [token];
}

function cookieValues(header: string | undefined, name: string): readonly string[] {
  if (header === undefined) return [];
  return header.split(';').flatMap((pair) => {
    const index = pair.indexOf('=');
    if (index < 0 || pair.slice(0, index).trim() !== name) return [];
    return [pair.slice(index + 1).trim()];
  });
}

/** The session tokens a request carries: an `Authorization: Bearer` token, then every `bps_session` cookie. */
export function sessionTokensOf(request: FastifyRequest): readonly string[] {
  const candidates = [...bearerTokens(request.headers.authorization), ...cookieValues(request.headers.cookie, SESSION_COOKIE)];
  return candidates.filter((token) => TOKEN_PATTERN.test(token));
}

export interface SessionMatch {
  readonly token: string;
  readonly session: Session;
}

/** The first live session among the tokens the request carries. */
export function findSession(request: FastifyRequest, sessions: MemorySessionStore): SessionMatch | undefined {
  for (const token of sessionTokensOf(request)) {
    const session = sessions.find(token);
    if (session !== undefined) return { token, session };
  }
  return undefined;
}

/** The `Set-Cookie` value that hands a session token to a browser. */
export function sessionCookie(token: string, maxAgeMs: number): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${Math.floor(maxAgeMs / 1000)}; ${COOKIE_ATTRIBUTES}`;
}

/** The `Set-Cookie` value that removes the session cookie. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`;
}

export interface SessionVerifierOptions {
  readonly sessions: MemorySessionStore;
  readonly users: Pick<UserRepository, 'get'>;
}

/**
 * Recognizes a caller by a live session. The actor comes from the user record on every request, so
 * a role change applies at once; a session of a deleted or disabled account is revoked and misses.
 */
export function createSessionVerifier(options: SessionVerifierOptions): CredentialVerifier {
  const { sessions, users } = options;
  const actorOf = (request: FastifyRequest): Actor | undefined => {
    const match = findSession(request, sessions);
    if (match === undefined) return undefined;
    const account = users.get(match.session.userId);
    if (account === undefined || account.disabledAt !== undefined) {
      sessions.revoke(match.token);
      return undefined;
    }
    return accountToActor(account);
  };
  return { verify: (request) => Promise.resolve(actorOf(request)) };
}

/**
 * The resolver with login on: the session verifier goes ahead of any other verifier, and a caller
 * none recognizes gets 401 `unauthenticated`. There is no local admin with login on.
 */
export function loginActorResolver(session: CredentialVerifier, others: readonly CredentialVerifier[] = []): ActorResolver {
  return createActorResolver({ verifiers: [session, ...others], fallback: 'deny' });
}
