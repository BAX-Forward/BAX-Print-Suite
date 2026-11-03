import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../api/queries';
import {
  applyEventToCache,
  connectLive,
  eventAffectsLists,
  type ConnectionState,
  type EventSourceFactory,
} from './events';

/** Coalesces list refetches when many events arrive together (e.g. a batch dropped in a hot folder). */
const LIST_REFRESH_DEBOUNCE_MS = 150;

const LiveContext = createContext<ConnectionState>('connecting');

export function LiveProvider({
  url,
  factory,
  children,
}: {
  url: string;
  factory: EventSourceFactory;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ConnectionState>('connecting');

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let hasOpened = false;

    const refreshLists = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.jobLists });
      }, LIST_REFRESH_DEBOUNCE_MS);
    };

    const disconnect = connectLive({
      url,
      factory,
      onState: (next) => {
        // After a reconnect, refetch everything: events may have been missed while offline.
        if (next === 'open' && hasOpened) void queryClient.invalidateQueries();
        if (next === 'open') hasOpened = true;
        setState(next);
      },
      onEvent: (event) => {
        applyEventToCache(queryClient, event);
        if (eventAffectsLists(event)) refreshLists();
      },
    });

    return () => {
      clearTimeout(refreshTimer);
      disconnect();
    };
  }, [queryClient, url, factory]);

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}

export function useConnectionState(): ConnectionState {
  return useContext(LiveContext);
}
