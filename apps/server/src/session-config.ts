import { SqliteUserRepository, type Database } from '@bax-print/store';
import type { ActorResolver } from './actor-resolver.js';
import type { LoginRouteOptions } from './login-routes.js';
import { createSessionVerifier, loginActorResolver, MemorySessionStore } from './sessions.js';

/**
 * Spec 028d: login is opt-in. `BPS_LOGIN=1` with `BPS_DATABASE` mounts `POST /login` and
 * `POST /logout` and makes every guarded route need a session; with `BPS_LOGIN` unset nothing
 * changes and every caller is the local admin. Any other value stops the server at startup.
 */

export const LOGIN_ENV = 'BPS_LOGIN';
export const COOKIE_ENV = 'BPS_COOKIE';
export const DATABASE_ENV = 'BPS_DATABASE';

export type SessionConfig = { readonly enabled: false } | { readonly enabled: true; readonly cookie: boolean };

export class SessionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** Unset is off and `1` is on; anything else, the empty string included, is an error. */
function parseFlag(env: Env, name: string): boolean {
  const value = env[name];
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new SessionConfigError(`${name} must be 1 or unset, got ${JSON.stringify(value)}`);
}

export function parseSessionConfig(env: Env): SessionConfig {
  const login = parseFlag(env, LOGIN_ENV);
  const cookie = parseFlag(env, COOKIE_ENV);
  if (login === false) {
    if (cookie) throw new SessionConfigError(`${COOKIE_ENV}=1 needs ${LOGIN_ENV}=1`);
    return { enabled: false };
  }
  const database = env[DATABASE_ENV];
  if (database === undefined || database.trim() === '') {
    throw new SessionConfigError(`${LOGIN_ENV}=1 needs ${DATABASE_ENV}: user accounts live in the job database`);
  }
  return { enabled: true, cookie };
}

/** What `configureLogin` adds to `ServerDeps`: nothing with login off. */
export interface LoginDeps {
  readonly login?: LoginRouteOptions;
  readonly authenticate?: ActorResolver;
}

/** The login routes and the session actor resolver over the users of `database`. */
export function configureLogin(
  config: SessionConfig,
  database: Database | undefined,
  sessions: MemorySessionStore = new MemorySessionStore(),
): LoginDeps {
  if (config.enabled === false) return {};
  if (database === undefined) {
    throw new SessionConfigError(`${LOGIN_ENV}=1 needs ${DATABASE_ENV}: user accounts live in the job database`);
  }
  const users = new SqliteUserRepository(database);
  return {
    login: { users, sessions, cookie: config.cookie },
    authenticate: loginActorResolver(createSessionVerifier({ users, sessions })),
  };
}
