import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { hashPassword, toPublicAccount, verifyPassword } from '@bax-print/core';
import type { UserRepository } from '@bax-print/store';
import { invalid, unauthenticated } from './errors.js';
import { doc } from './openapi.js';
import { clearedSessionCookie, findSession, sessionCookie, type MemorySessionStore } from './sessions.js';

/**
 * Spec 028d: `POST /login` and `POST /logout`. Both are public routes: login is how a caller gets a
 * credential, and logout checks the session the request carries itself.
 */

/** One message for an unknown username, a wrong password and a disabled account. */
export const LOGIN_FAILED_MESSAGE = 'Username or password is incorrect';

const LOGIN_BODY_LIMIT = 4096;
const DECOY_PASSWORD_BYTES = 32;

export interface LoginRouteOptions {
  readonly users: Pick<UserRepository, 'getByUsername'>;
  readonly sessions: MemorySessionStore;
  /** True (`BPS_COOKIE=1`): the token is only set as the `bps_session` cookie. False: it is returned once in the JSON body. */
  readonly cookie: boolean;
}

interface LoginBody {
  readonly username: string;
  readonly password: string;
}

function parseLoginBody(body: unknown): LoginBody {
  if (typeof body === 'object' && body !== null && 'username' in body && 'password' in body) {
    const { username, password } = body;
    if (typeof username === 'string' && typeof password === 'string') return { username, password };
  }
  throw invalid('send { "username": string, "password": string } as JSON');
}

export function registerLoginRoutes(app: FastifyInstance, options: LoginRouteOptions): void {
  const { users, sessions, cookie } = options;
  // An unknown username still pays for one scrypt, so the response time does not tell which usernames exist.
  let decoy: Promise<string> | undefined;
  const decoyHash = (): Promise<string> => (decoy ??= hashPassword(randomBytes(DECOY_PASSWORD_BYTES).toString('base64url')));

  app.post(
    '/login',
    {
      bodyLimit: LOGIN_BODY_LIMIT,
      schema: doc({
        operationId: 'login',
        summary: 'Start a session with a username and password',
        tags: ['sessions'],
        bodyDoc: {
          type: 'object',
          required: ['username', 'password'],
          properties: { username: { type: 'string' }, password: { type: 'string', format: 'password' } },
        },
        responses: {
          200: 'Signed in. With `BPS_COOKIE=1` the token is only set as the HttpOnly `bps_session` cookie; otherwise `token` carries it, this once',
          400: 'The body is not `{ username, password }` (`invalid_request`)',
          401: 'Unknown username, wrong password or disabled account (`unauthenticated`, with the same message for each)',
        },
        responseSchema: 'LoginResult',
      }),
    },
    async (request, reply) => {
      const { username, password } = parseLoginBody(request.body);
      const account = users.getByUsername(username);
      const matches = await verifyPassword(password, account?.passwordHash ?? (await decoyHash()));
      if (account === undefined || account.disabledAt !== undefined || matches === false) {
        throw unauthenticated(LOGIN_FAILED_MESSAGE);
      }
      const issued = sessions.create(account.id);
      const result = { user: toPublicAccount(account), expiresAt: issued.expiresAt };
      reply.header('cache-control', 'no-store');
      if (cookie) {
        reply.header('set-cookie', sessionCookie(issued.token, sessions.ttlMs));
        return result;
      }
      return { ...result, token: issued.token };
    },
  );

  app.post(
    '/logout',
    {
      schema: doc({
        operationId: 'logout',
        summary: 'Revoke the session the request carries',
        tags: ['sessions'],
        responses: {
          204: 'Signed out. With `BPS_COOKIE=1` the `bps_session` cookie is cleared',
          401: 'The request carries no live session, as a `bps_session` cookie or a bearer token (`unauthenticated`)',
        },
      }),
    },
    async (request, reply) => {
      const match = findSession(request, sessions);
      if (match === undefined) throw unauthenticated();
      sessions.revoke(match.token);
      if (cookie) reply.header('set-cookie', clearedSessionCookie());
      return reply.status(204).send();
    },
  );
}
