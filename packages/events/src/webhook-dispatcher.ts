import type { CloudEvent } from './cloudevent.js';
import {
  deliverWebhook,
  matchesSubscription,
  nextRetryDelayMs,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookDeliveryDeps,
  type WebhookSubscription,
} from './webhooks.js';

/** Fans events out to matching webhook subscriptions with retries (Spec 019b), on top of the 019a delivery core. */

export const WEBHOOK_DELIVERY_LOG_LIMIT = 1_000;

/** Runs `fn` after `delayMs`; the returned function cancels it. */
export type WebhookRetryScheduler = (delayMs: number, fn: () => void) => () => void;

export interface WebhookDeliveryLogEntry {
  readonly subscriptionId: string;
  readonly eventId: string;
  readonly attempt: number;
  readonly ok: boolean;
  readonly status?: number;
  readonly error?: string;
  /** When the attempt finished, as an ISO 8601 timestamp. */
  readonly at: string;
}

export interface WebhookDispatcherOptions {
  /** The current subscriptions; read on every dispatch and again before each retry. */
  readonly subscriptions: () => readonly WebhookSubscription[];
  readonly send: WebhookDeliveryDeps['send'];
  /** Current time in milliseconds since the Unix epoch. */
  readonly now: () => number;
  readonly schedule: WebhookRetryScheduler;
  readonly maxAttempts?: number;
  /** Newest entries kept in the delivery log. Default `WEBHOOK_DELIVERY_LOG_LIMIT`. */
  readonly logLimit?: number;
  readonly onError?: (error: unknown, event: CloudEvent) => void;
}

interface PendingRetry {
  cancel: () => void;
}

function reportDispatchError(error: unknown, event: CloudEvent): void {
  console.error(`webhook dispatch failed for ${event.type} ${event.id}`, error);
}

export class WebhookDispatcher {
  private readonly log: WebhookDeliveryLogEntry[] = [];
  private readonly pending = new Set<PendingRetry>();
  private readonly deps: WebhookDeliveryDeps;
  private readonly maxAttempts: number;
  private readonly logLimit: number;
  private readonly onError: (error: unknown, event: CloudEvent) => void;

  constructor(private readonly options: WebhookDispatcherOptions) {
    this.deps = { send: options.send, now: options.now };
    this.maxAttempts = options.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS;
    this.logLimit = options.logLimit ?? WEBHOOK_DELIVERY_LOG_LIMIT;
    if (!Number.isSafeInteger(this.logLimit) || this.logLimit < 1) {
      throw new RangeError('webhook delivery log limit must be a positive integer');
    }
    this.onError = options.onError ?? reportDispatchError;
  }

  /** Makes the first delivery attempt to every matching subscription. Never rejects. */
  async dispatch(event: CloudEvent): Promise<void> {
    let targets: readonly WebhookSubscription[];
    try {
      targets = this.options.subscriptions().filter((subscription) => matchesSubscription(subscription, event));
    } catch (error) {
      this.onError(error, event);
      return;
    }
    await Promise.all(targets.map((subscription) => this.attempt(subscription, event, 1)));
  }

  /** Log entries, oldest first; only those of one subscription when `subscriptionId` is given. */
  deliveries(subscriptionId?: string): readonly WebhookDeliveryLogEntry[] {
    return subscriptionId === undefined ? [...this.log] : this.log.filter((entry) => entry.subscriptionId === subscriptionId);
  }

  /** Number of retries scheduled and not yet run. */
  get pendingRetries(): number {
    return this.pending.size;
  }

  /** Cancels every scheduled retry. Later `dispatch` calls still deliver. */
  stop(): void {
    for (const retry of this.pending) retry.cancel();
    this.pending.clear();
  }

  /** Never rejects: `deliverWebhook` reports send failures, anything else goes to `onError`. */
  private async attempt(subscription: WebhookSubscription, event: CloudEvent, attempt: number): Promise<void> {
    try {
      const result = await deliverWebhook(subscription, event, this.deps, attempt);
      this.record({
        subscriptionId: subscription.id,
        eventId: event.id,
        attempt: result.attempt,
        ok: result.ok,
        ...(result.status !== undefined ? { status: result.status } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        at: new Date(this.options.now()).toISOString(),
      });
      if (!result.ok && result.retryable !== false) this.scheduleRetry(subscription.id, event, attempt);
    } catch (error) {
      this.onError(error, event);
    }
  }

  private record(entry: WebhookDeliveryLogEntry): void {
    this.log.push(Object.freeze(entry));
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
  }

  private scheduleRetry(subscriptionId: string, event: CloudEvent, failedAttempt: number): void {
    const delayMs = nextRetryDelayMs(failedAttempt, this.maxAttempts);
    if (delayMs === null) return;
    const retry: PendingRetry = { cancel: () => undefined };
    this.pending.add(retry);
    retry.cancel = this.options.schedule(delayMs, () => {
      if (!this.pending.delete(retry)) return;
      void this.retry(subscriptionId, event, failedAttempt + 1);
    });
  }

  /** A subscription deleted or deactivated since the last attempt gets no further attempts. */
  private async retry(subscriptionId: string, event: CloudEvent, attempt: number): Promise<void> {
    let subscription: WebhookSubscription | undefined;
    try {
      subscription = this.options.subscriptions().find((candidate) => candidate.id === subscriptionId);
    } catch (error) {
      this.onError(error, event);
      return;
    }
    if (subscription === undefined || !matchesSubscription(subscription, event)) return;
    await this.attempt(subscription, event, attempt);
  }
}
