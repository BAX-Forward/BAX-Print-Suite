import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireRole, ulid, type Actor } from '@bax-print/core';
import {
  BlockedWebhookDestinationError,
  checkWebhookTarget,
  guardedWebhookSend,
  resolveAllAddresses,
  validateWebhookSubscription,
  WEBHOOK_MIN_SECRET_LENGTH,
  WebhookDispatcher,
  type EventBus,
  type WebhookRetryScheduler,
  type WebhookSubscription,
  type WebhookTargetPolicy,
  type WebhookTransport,
} from '@bax-print/events';
import { conflict, invalid, notFound } from './errors.js';
import { doc } from './openapi.js';
import { MemoryWebhookSubscriptionStore, type WebhookSubscriptionStore, type WebhookSubscriptionSummary } from './stores.js';
import { nodeWebhookTransport } from './webhook-send.js';

/**
 * Spec 019b routes:
 * - `POST /webhooks`, `GET /webhooks`, `DELETE /webhooks/:id` (admin only);
 * - `GET /webhooks/:id/deliveries`, the in-memory delivery log of one subscription.
 *
 * Every event published on the bus (and so appended to the outbox) is dispatched to the active
 * matching subscriptions. The signing secret is write-only: no response contains it.
 * Errors use `{ error: { code, message, details? } }`.
 *
 * Spec 019c: a subscription URL must pass the SSRF target check at creation (400 otherwise) and
 * again before every delivery attempt (a failed, unretried `blocked-destination` attempt otherwise).
 */

/** Retry scheduler on Node timers; pending retries do not keep the process alive. */
export const timerSchedule: WebhookRetryScheduler = (delayMs, fn) => {
  const timer = setTimeout(fn, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

/** Environment variable for `webhooks.allowLanTargets`. */
export const ALLOW_LAN_TARGETS_ENV = 'BPS_WEBHOOKS_ALLOW_LAN_TARGETS';

/** Parses `webhooks.allowLanTargets` from the environment: unset or empty is false; anything but true/false/1/0 throws. */
export function parseAllowLanTargets(value: string | undefined): boolean {
  const text = (value ?? '').trim().toLowerCase();
  if (text === '' || text === 'false' || text === '0') return false;
  if (text === 'true' || text === '1') return true;
  throw new RangeError(`${ALLOW_LAN_TARGETS_ENV} must be true or false`);
}

export interface WebhookOptions {
  /** Every event published on this bus is dispatched. */
  readonly bus: EventBus;
  /** Default: a new in-memory store. */
  readonly store?: WebhookSubscriptionStore;
  /** Sends to a target the SSRF guard already vetted; the guard always runs first. Default: `nodeWebhookTransport`. */
  readonly send?: WebhookTransport;
  /** Every address a host resolves to. Default: `resolveAllAddresses` (the system resolver). */
  readonly resolve?: WebhookTargetPolicy['resolve'];
  /** `webhooks.allowLanTargets`: allow private (LAN) addresses, never loopback or link-local. Default: false. */
  readonly allowLanTargets?: boolean;
  /** Current time in milliseconds since the Unix epoch. Default: `Date.now`. */
  readonly now?: () => number;
  /** Default: `timerSchedule`. */
  readonly schedule?: WebhookRetryScheduler;
  /** Ids for subscriptions created without one. Default: a ULID. */
  readonly newId?: () => string;
}

export interface WebhookRouteDeps extends WebhookOptions {
  /** The caller; managing webhooks requires the admin role. */
  readonly authenticate: (request: FastifyRequest) => Actor;
}

/** A subscription as the API returns it. */
export type PublicWebhookSubscription = Omit<WebhookSubscription, 'secret'>;

type IdParams = { Params: { id: string } };

const ID = { type: 'string', minLength: 1 };
const idParams = { type: 'object', required: ['id'], properties: { id: ID } };

const subscriptionBody = {
  type: 'object',
  required: ['url', 'secret', 'eventTypes'],
  properties: {
    id: ID,
    url: { type: 'string', minLength: 1 },
    secret: { type: 'string', minLength: WEBHOOK_MIN_SECRET_LENGTH, writeOnly: true },
    eventTypes: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    active: { type: 'boolean' },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function publicSubscription(subscription: WebhookSubscriptionSummary): PublicWebhookSubscription {
  const { id, url, eventTypes, active } = subscription;
  return { id, url, eventTypes, active };
}

/** Rejects a subscription URL the SSRF guard blocks or that cannot be resolved; the error answers 400. */
async function requireAllowedTarget(url: string, policy: WebhookTargetPolicy): Promise<void> {
  let check: Awaited<ReturnType<typeof checkWebhookTarget>>;
  try {
    check = await checkWebhookTarget(url, policy);
  } catch {
    throw invalid('webhook subscription "url" host could not be resolved');
  }
  if (!check.ok) throw new BlockedWebhookDestinationError(check.reason);
}

/** Mounts the webhook routes and subscribes the dispatcher to the bus until the app closes. */
export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): WebhookDispatcher {
  const store = deps.store ?? new MemoryWebhookSubscriptionStore();
  const newId = deps.newId ?? (() => ulid(Date.now()));
  const policy: WebhookTargetPolicy = { resolve: deps.resolve ?? resolveAllAddresses, allowLan: deps.allowLanTargets ?? false };
  const dispatcher = new WebhookDispatcher({
    subscriptions: () => store.list().flatMap((summary) => store.getWithSecret(summary.id) ?? []),
    send: guardedWebhookSend(deps.send ?? nodeWebhookTransport, policy),
    now: deps.now ?? Date.now,
    schedule: deps.schedule ?? timerSchedule,
    onError: (error, event) => app.log.error({ err: error, eventId: event.id }, 'webhook dispatch failed'),
  });
  const unsubscribe = deps.bus.subscribe((event) => {
    void dispatcher.dispatch(event);
  });
  app.addHook('onClose', async () => {
    unsubscribe();
    dispatcher.stop();
  });

  const requireAdmin = (request: FastifyRequest): void => requireRole(deps.authenticate(request), 'admin', 'managing webhooks');

  app.post(
    '/webhooks',
    {
      schema: doc({
        operationId: 'createWebhookSubscription',
        summary: 'Subscribe a URL to events',
        tags: ['webhooks'],
        body: subscriptionBody,
        responses: { 201: 'Created', 400: 'Invalid or blocked target', 403: 'Admin only', 409: 'Id in use' },
        responseSchema: 'WebhookSubscription',
      }),
    },
    async (request, reply) => {
      requireAdmin(request);
      const body = request.body;
      if (!isRecord(body)) throw invalid('Request body must be a JSON object');
      const subscription = validateWebhookSubscription({ active: true, ...body, id: body.id ?? newId() });
      if (store.get(subscription.id) !== undefined) throw conflict(`Webhook subscription ${subscription.id} already exists`);
      await requireAllowedTarget(subscription.url, policy);
      store.put(subscription);
      return reply.code(201).send(publicSubscription(subscription));
    },
  );

  app.get(
    '/webhooks',
    {
      schema: doc({
        operationId: 'listWebhookSubscriptions',
        summary: 'List webhook subscriptions',
        tags: ['webhooks'],
        responses: { 200: 'OK', 403: 'Admin only' },
        responseSchema: 'WebhookSubscriptionList',
      }),
    },
    async (request) => {
      requireAdmin(request);
      return { items: store.list().map(publicSubscription) };
    },
  );

  app.delete<IdParams>(
    '/webhooks/:id',
    {
      schema: doc({
        operationId: 'deleteWebhookSubscription',
        summary: 'Delete a webhook subscription; its scheduled retries are dropped',
        tags: ['webhooks'],
        params: idParams,
        responses: { 204: 'Deleted', 403: 'Admin only', 404: 'Not found' },
      }),
    },
    async (request, reply) => {
      requireAdmin(request);
      if (!store.delete(request.params.id)) throw notFound('Webhook subscription', request.params.id);
      return reply.code(204).send();
    },
  );

  app.get<IdParams>(
    '/webhooks/:id/deliveries',
    {
      schema: doc({
        operationId: 'listWebhookDeliveries',
        summary: 'Recent delivery attempts of a subscription, oldest first',
        tags: ['webhooks'],
        params: idParams,
        responses: { 200: 'OK', 403: 'Admin only', 404: 'Not found' },
        responseSchema: 'WebhookDeliveryList',
      }),
    },
    async (request) => {
      requireAdmin(request);
      const { id } = request.params;
      if (store.get(id) === undefined) throw notFound('Webhook subscription', id);
      return { items: dispatcher.deliveries(id) };
    },
  );

  return dispatcher;
}
