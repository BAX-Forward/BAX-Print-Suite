import { createContext, useContext, type ReactNode } from 'react';
import type { ThumbnailRenderer } from './types';

const unavailable: ThumbnailRenderer = {
  render: () => Promise.reject(new Error('No preview renderer configured')),
};

const PreviewContext = createContext<ThumbnailRenderer>(unavailable);

export function PreviewProvider({ renderer, children }: { renderer: ThumbnailRenderer; children: ReactNode }) {
  return <PreviewContext.Provider value={renderer}>{children}</PreviewContext.Provider>;
}

export function usePreviewRenderer(): ThumbnailRenderer {
  return useContext(PreviewContext);
}
