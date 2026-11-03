import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Most files run in jsdom; a few (e.g. the lint test) opt into `@vitest-environment node`.
const hasDom = typeof window !== 'undefined';

afterEach(() => {
  cleanup();
  if (hasDom) localStorage.clear();
});

// jsdom has no layout, so ResizeObserver (used by the row virtualizer) is missing.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (hasDom && typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
}

// jsdom has no canvas backend; returning null matches "2D context unavailable" without log noise.
if (hasDom) {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}
