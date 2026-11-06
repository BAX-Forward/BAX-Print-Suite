import { describe, expect, it } from 'vitest';
import {
  DATABASE_URL_ENV,
  DatabaseUrlError,
  DEFAULT_POSTGRES_PORT,
  parseDatabaseUrl,
  redactDatabaseUrl,
  UNPARSEABLE_DATABASE_URL,
} from '../src/database-url.js';

/** An obvious fake; no test here uses a real credential. */
const PASSWORD = 'fake-pw-027d';

function parse(value: string): ReturnType<typeof parseDatabaseUrl> {
  return parseDatabaseUrl({ [DATABASE_URL_ENV]: value });
}

function parseError(value: string): DatabaseUrlError {
  try {
    parse(value);
  } catch (error) {
    if (error instanceof DatabaseUrlError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(value)} to be rejected`);
}

describe('parseDatabaseUrl (Spec 027d)', () => {
  it('is undefined when the variable is absent', () => {
    expect(parseDatabaseUrl({})).toBeUndefined();
    expect(parseDatabaseUrl({ [DATABASE_URL_ENV]: undefined })).toBeUndefined();
  });

  it('parses a full postgres:// URL into a frozen config', () => {
    const config = parse(`postgres://app:${PASSWORD}@db.example.test:6543/bps?sslmode=verify-full`);

    expect(config).toStrictEqual({
      host: 'db.example.test',
      port: 6543,
      database: 'bps',
      user: 'app',
      hasPassword: true,
      sslmode: 'verify-full',
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('accepts postgresql:// and defaults the port to 5432', () => {
    expect(parse('postgresql://db.example.test/bps')).toStrictEqual({
      host: 'db.example.test',
      port: DEFAULT_POSTGRES_PORT,
      database: 'bps',
      hasPassword: false,
    });
    expect(DEFAULT_POSTGRES_PORT).toBe(5432);
  });

  it('reads a user without a password', () => {
    expect(parse('postgres://app@db.example.test/bps')).toStrictEqual({
      host: 'db.example.test',
      port: 5432,
      database: 'bps',
      user: 'app',
      hasPassword: false,
    });
  });

  it('decodes percent escapes in the user and database name', () => {
    const config = parse('postgres://app%40site@db.example.test/print%20jobs');

    expect(config?.user).toBe('app@site');
    expect(config?.database).toBe('print jobs');
  });

  it('strips the brackets of an IPv6 host', () => {
    expect(parse('postgres://[::1]:5433/bps')).toMatchObject({ host: '::1', port: 5433 });
  });

  it('counts a password query parameter as a password', () => {
    expect(parse(`postgres://db.example.test/bps?password=${PASSWORD}`)?.hasPassword).toBe(true);
  });

  it.each(['', 'not a url', 'db.example.test/bps'])('rejects %j as not a URL', (value) => {
    expect(parseError(value).message).toContain(DATABASE_URL_ENV);
  });

  it.each(['mysql://db.example.test/bps', 'http://db.example.test/bps', 'sqlite:///data/bps.db'])(
    'rejects the scheme of %j',
    (value) => {
      expect(parseError(value).message).toContain('postgres://');
    },
  );

  it.each(['postgres:///bps', 'postgres:/bps', 'postgres:bps'])('rejects %j without a host', (value) => {
    expect(parseError(value).message).toContain(DATABASE_URL_ENV);
  });

  it.each(['postgres://db.example.test', 'postgres://db.example.test/', 'postgres://db.example.test:5433/'])(
    'rejects %j without a database name',
    (value) => {
      expect(parseError(value).message).toContain('database');
    },
  );

  it('rejects a path with more than one segment', () => {
    expect(parseError('postgres://db.example.test/bps/extra').message).toContain('one database');
  });

  it.each(['0', '65536', '99999', 'abc', '-1', '54.32'])('rejects port %j', (port) => {
    expect(parseError(`postgres://db.example.test:${port}/bps`).message).toContain(DATABASE_URL_ENV);
  });

  it('names the range for port 0', () => {
    expect(parseError('postgres://db.example.test:0/bps').message).toContain('1 to 65535');
  });

  it('rejects an unknown sslmode', () => {
    expect(parseError('postgres://db.example.test/bps?sslmode=always').message).toContain('sslmode');
  });

  it('rejects a malformed percent escape in the user name', () => {
    expect(parseError('postgres://app%zz@db.example.test/bps').message).toContain('user name');
  });
});

describe('password never in errors (Spec 027d)', () => {
  it.each([
    `mysql://app:${PASSWORD}@db.example.test/bps`,
    `postgres://app:${PASSWORD}@/bps`,
    `postgres://app:${PASSWORD}@db.example.test`,
    `postgres://app:${PASSWORD}@db.example.test/a/b`,
    `postgres://app:${PASSWORD}@db.example.test:0/bps`,
    `postgres://app:${PASSWORD}@db.example.test:99999/bps`,
    `postgres://app:${PASSWORD}@db.example.test:abc/bps`,
    `postgres://app:${PASSWORD}@db.example.test/bps?sslmode=nope`,
    `postgres://app%zz:${PASSWORD}@db.example.test/bps`,
    `postgres://app:${PASSWORD}@db.example.test/bps%zz`,
    `://app:${PASSWORD}@db.example.test/bps`,
  ])('keeps the password out of the error for %j', (value) => {
    const error = parseError(value);

    expect(error.message).not.toContain(PASSWORD);
    expect(error.cause).toBeUndefined();
    expect(String(error.stack)).not.toContain(PASSWORD);
  });
});

describe('redactDatabaseUrl (Spec 027d)', () => {
  it('replaces the userinfo password with ***', () => {
    const redacted = redactDatabaseUrl(`postgres://app:${PASSWORD}@db.example.test:6543/bps?sslmode=require`);

    expect(redacted).toBe('postgres://app:***@db.example.test:6543/bps?sslmode=require');
    expect(redacted).not.toContain(PASSWORD);
  });

  it('replaces a password query parameter with ***', () => {
    const redacted = redactDatabaseUrl(`postgresql://app@db.example.test/bps?password=${PASSWORD}&sslmode=disable`);

    expect(redacted).toBe('postgresql://app@db.example.test/bps?password=***&sslmode=disable');
  });

  it('leaves a URL without a password unchanged', () => {
    expect(redactDatabaseUrl('postgres://app@db.example.test/bps')).toBe('postgres://app@db.example.test/bps');
  });

  it('returns a placeholder for a value that is not a URL', () => {
    const redacted = redactDatabaseUrl(`://app:${PASSWORD}@db.example.test/bps`);

    expect(redacted).toBe(UNPARSEABLE_DATABASE_URL);
    expect(redacted).not.toContain(PASSWORD);
  });
});
