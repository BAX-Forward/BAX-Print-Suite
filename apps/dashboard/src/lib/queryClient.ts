import { QueryClient } from '@tanstack/react-query';

const STALE_TIME_MS = 5_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // SSE keeps data fresh; refetch on focus covers missed events after sleep.
      queries: { retry: 1, staleTime: STALE_TIME_MS },
      mutations: { retry: false },
    },
  });
}
