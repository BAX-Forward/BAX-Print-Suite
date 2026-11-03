import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/client';
import { strings } from '../strings';
import { useToast } from './Toasts';

/**
 * Shows a toast for every failed query or mutation, except those marked with INLINE_ERRORS
 * (their screens show the error next to the form or content instead).
 */
export function QueryErrorToasts() {
  const queryClient = useQueryClient();
  const toast = useToast();

  useEffect(() => {
    const report = (error: unknown, meta: Record<string, unknown> | undefined) => {
      if (meta?.inlineErrors) return;
      toast.error(errorMessage(error, strings.errors.unknown));
    };
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') report(event.action.error, event.query.meta);
    });
    const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') {
        report(event.action.error, event.mutation.options.meta);
      }
    });
    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [queryClient, toast]);

  return null;
}
