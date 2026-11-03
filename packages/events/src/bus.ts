import { systemClock, ulid, type Clock } from '@bax-print/core';
import { createEvent, type CloudEvent, type EventInput } from './cloudevent.js';
import type { Outbox } from './outbox.js';

export type EventListener = (event: CloudEvent) => void;

export interface EventBusOptions {
  readonly clock?: Clock;
  readonly newId?: () => string;
  readonly onListenerError?: (error: unknown, event: CloudEvent) => void;
}

function reportListenerError(error: unknown, event: CloudEvent): void {
  console.error(`event listener failed for ${event.type} ${event.id}`, error);
}

/** Typed in-process bus. Every event is written to the outbox before listeners run. */
export class EventBus {
  private readonly listeners = new Set<EventListener>();
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly onListenerError: (error: unknown, event: CloudEvent) => void;

  constructor(
    private readonly outbox: Outbox,
    options: EventBusOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? (() => ulid(this.clock().getTime()));
    this.onListenerError = options.onListenerError ?? reportListenerError;
  }

  publish<T>(input: EventInput<T>): CloudEvent<T> {
    const record = this.outbox.append(createEvent(input, this.newId(), this.clock()));
    for (const listener of this.listeners) {
      try {
        listener(record.event);
      } catch (error) {
        this.onListenerError(error, record.event);
      }
    }
    return record.event as CloudEvent<T>;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
