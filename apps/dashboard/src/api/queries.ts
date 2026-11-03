import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from './ApiContext';
import type { JobListParams } from './client';
import type { DeviceCreate, DevicePatch, HotFolderCreate, HotFolderPatch, JobPage, JobPatch } from './types';

export const JOBS_PAGE_SIZE = 50;

export type JobListFilters = Omit<JobListParams, 'cursor' | 'limit'>;

/** Mutations with this meta show their errors inline instead of as a global toast. */
export const INLINE_ERRORS = { inlineErrors: true } as const;

export const queryKeys = {
  jobs: ['jobs'] as const,
  jobLists: ['jobs', 'list'] as const,
  jobList: (filters: JobListFilters) => ['jobs', 'list', filters] as const,
  job: (id: string) => ['jobs', 'detail', id] as const,
  transitions: (id: string) => ['jobs', 'transitions', id] as const,
  hotFolders: ['hotfolders'] as const,
  plugins: ['plugins'] as const,
  devices: ['devices'] as const,
};

export function useJobList(filters: JobListFilters) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: queryKeys.jobList(filters),
    queryFn: ({ pageParam, signal }) =>
      api.listJobs({ ...filters, cursor: pageParam ?? undefined, limit: JOBS_PAGE_SIZE }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: JobPage) => lastPage.nextCursor,
  });
}

export function useJob(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.job(id),
    queryFn: ({ signal }) => api.getJob(id, signal),
    meta: INLINE_ERRORS,
  });
}

export function useTransitions(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.transitions(id),
    queryFn: ({ signal }) => api.getTransitions(id, signal),
  });
}

export function useHotFolders() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.hotFolders, queryFn: ({ signal }) => api.listHotFolders(signal) });
}

export function usePlugins() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.plugins, queryFn: ({ signal }) => api.listPlugins(signal) });
}

export function useDevices() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.devices, queryFn: ({ signal }) => api.listDevices(signal) });
}

export function usePatchJob() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: JobPatch }) => api.patchJob(id, patch),
    onSuccess: (job) => {
      queryClient.setQueryData(queryKeys.job(job.id), job);
      void queryClient.invalidateQueries({ queryKey: queryKeys.transitions(job.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobLists });
    },
  });
}

export function usePrintJob() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, deviceId }: { id: string; deviceId: string }) => api.printJob(id, deviceId),
    onSuccess: (job) => {
      queryClient.setQueryData(queryKeys.job(job.id), job);
      void queryClient.invalidateQueries({ queryKey: queryKeys.transitions(job.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobLists });
    },
  });
}

export function useCreateHotFolder() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: HotFolderCreate) => api.createHotFolder(input),
    meta: INLINE_ERRORS,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.hotFolders }),
  });
}

export function usePatchHotFolder() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: HotFolderPatch }) => api.patchHotFolder(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.hotFolders }),
  });
}

export function useDeleteHotFolder() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteHotFolder(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.hotFolders }),
  });
}

export function useCreateDevice() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DeviceCreate) => api.createDevice(input),
    meta: INLINE_ERRORS,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.devices }),
  });
}

export function usePatchDevice() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: DevicePatch }) => api.patchDevice(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.devices }),
  });
}
