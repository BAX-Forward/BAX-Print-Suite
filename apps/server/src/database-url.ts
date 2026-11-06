/**
 * Spec 027d: `BPS_DATABASE_URL` names a PostgreSQL server as a connection URI (PostgreSQL
 * documentation, "Connection URIs"). This build only parses it at startup and never connects.
 * Unset changes nothing; an invalid value stops the server. No error message carries the password.
 */

export const DATABASE_URL_ENV = 'BPS_DATABASE_URL';
export const DEFAULT_POSTGRES_PORT = 5432;
export const SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'] as const;
export type SslMode = (typeof SSL_MODES)[number];

const SCHEMES: ReadonlySet<string> = new Set(['postgres:', 'postgresql:']);
const MAX_PORT = 65535;
const PASSWORD_PARAM = 'password';
const REDACTED = '***';
/** What `redactDatabaseUrl` returns for a value that is not a URL, so nothing of it is echoed. */
export const UNPARSEABLE_DATABASE_URL = '<unparseable database URL>';

export interface DatabaseUrlConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user?: string;
  /** True when the URL carries a password, in the userinfo or as a `password` query parameter. */
  readonly hasPassword: boolean;
  readonly sslmode?: SslMode;
}

export class DatabaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseUrlError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** `undefined` when BPS_DATABASE_URL is unset; a frozen config for a valid URL; throws otherwise. */
export function parseDatabaseUrl(env: Env): DatabaseUrlConfig | undefined {
  const value = env[DATABASE_URL_ENV];
  if (value === undefined) return undefined;
  const url = parseUrl(value);
  // The parser's own error keeps the input, so it is never passed on as a cause.
  if (url === undefined) throw new DatabaseUrlError(`${DATABASE_URL_ENV} is not a valid URL`);
  if (SCHEMES.has(url.protocol) === false) {
    throw new DatabaseUrlError(`${DATABASE_URL_ENV} must use postgres:// or postgresql://, got ${JSON.stringify(url.protocol)}`);
  }
  const host = parseHost(url.hostname);
  const user = decode(url.username, 'user name');
  const sslmode = parseSslMode(url.searchParams.get('sslmode'));
  return Object.freeze({
    host,
    port: parsePort(url.port),
    database: parseDatabase(url.pathname),
    ...(user.length > 0 ? { user } : {}),
    hasPassword: url.password.length > 0 || url.searchParams.has(PASSWORD_PARAM),
    ...(sslmode === undefined ? {} : { sslmode }),
  });
}

/** The URL with its password, in the userinfo or the query, replaced by `***`. */
export function redactDatabaseUrl(value: string): string {
  const url = parseUrl(value);
  if (url === undefined) return UNPARSEABLE_DATABASE_URL;
  if (url.password.length > 0) url.password = REDACTED;
  if (url.searchParams.has(PASSWORD_PARAM)) url.searchParams.set(PASSWORD_PARAM, REDACTED);
  return url.href;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function parseHost(hostname: string): string {
  if (hostname.length === 0) throw new DatabaseUrlError(`${DATABASE_URL_ENV} must name a host`);
  // An IPv6 literal is serialized in brackets; the host itself is the address.
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** The URL parser already rejects ports that are not digits or are above 65535. */
function parsePort(port: string): number {
  if (port.length === 0) return DEFAULT_POSTGRES_PORT;
  const value = Number(port);
  if (Number.isInteger(value) && value >= 1 && value <= MAX_PORT) return value;
  throw new DatabaseUrlError(`${DATABASE_URL_ENV} port must be 1 to ${MAX_PORT}, got ${port}`);
}

function parseDatabase(pathname: string): string {
  const database = decode(pathname.startsWith('/') ? pathname.slice(1) : pathname, 'database name');
  if (database.length === 0) throw new DatabaseUrlError(`${DATABASE_URL_ENV} must name a database`);
  if (pathname.slice(1).includes('/')) {
    throw new DatabaseUrlError(`${DATABASE_URL_ENV} must name one database, got a path with more than one segment`);
  }
  return database;
}

function parseSslMode(value: string | null): SslMode | undefined {
  if (value === null) return undefined;
  const mode = SSL_MODES.find((candidate) => candidate === value);
  if (mode === undefined) {
    throw new DatabaseUrlError(`${DATABASE_URL_ENV} sslmode must be one of ${SSL_MODES.join(', ')}, got ${JSON.stringify(value)}`);
  }
  return mode;
}

function decode(value: string, what: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new DatabaseUrlError(`${DATABASE_URL_ENV} ${what} has a malformed percent escape`);
  }
}
