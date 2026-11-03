import type { CloudEvent } from '../src/api/types';
import type { EventSourceFactory, EventSourceLike } from '../src/live/events';

/** In-memory CloudEvents bus for the mock API; feeds both mock EventSources and `GET /events`. */

export type EventListener = (event: CloudEvent) => void;

const EVENT_SOURCE = '/bps/mock';

export function createEventBus() {
  const listeners = new Set<EventListener>();
  let sequence = 0;

  return {
    publish(type: string, subject: string | undefined, data: Record<string, unknown>, time: string): CloudEvent {
      sequence += 1;
      const event: CloudEvent = {
        specversion: '1.0',
        id: `mock-${sequence}`,
        type,
        source: EVENT_SOURCE,
        subject,
        time,
        datacontenttype: 'application/json',
        data,
      };
      for (const listener of [...listeners]) listener(event);
      return event;
    },
    subscribe(listener: EventListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type EventBus = ReturnType<typeof createEventBus>;

/** Formats one event the way the server's SSE stream does (`event` field = CloudEvent type). */
export function toSseFrame(event: CloudEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

/** Behaves like a browser EventSource connected to the mock bus. */
class MockEventSource implements EventSourceLike {
  readyState = CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  private unsubscribe: (() => void) | null = null;

  constructor(bus: EventBus) {
    // Open asynchronously, like a real connection, so handlers can be attached first.
    setTimeout(() => {
      if (this.readyState === CLOSED) return;
      this.readyState = OPEN;
      this.unsubscribe = bus.subscribe((event) => this.dispatch(event));
      this.onopen?.(new Event('open'));
    }, 0);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  close(): void {
    this.readyState = CLOSED;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private dispatch(event: CloudEvent): void {
    // A real EventSource only delivers named events to listeners registered for that name.
    const listeners = this.listeners.get(event.type);
    if (!listeners) return;
    const message = new MessageEvent(event.type, { data: JSON.stringify(event), lastEventId: event.id });
    for (const listener of listeners) listener(message);
  }
}

export function createMockEventSourceFactory(bus: EventBus): EventSourceFactory {
  return () => new MockEventSource(bus);
}
