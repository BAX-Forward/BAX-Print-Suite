import type { JobListFilters } from '../api/queries';
import { JOB_SORTS, JOB_STATUSES, type JobSort, type JobStatus, type SortField } from '../api/types';

/** Jobs-screen filter state, persisted in the URL so views can be bookmarked and shared. */
export interface JobFilters {
  status: JobStatus[];
  q: string;
  hotFolderId: string;
  deviceId: string;
  sort: JobSort;
}

export const DEFAULT_SORT: JobSort = '-createdAt';

/** First click on a column sorts in this direction; names read best A→Z, the rest newest/highest first. */
const DEFAULT_DESC: Record<SortField, boolean> = { createdAt: true, priority: true, name: false };

export function readJobFilters(params: URLSearchParams): JobFilters {
  const status = params
    .getAll('status')
    .flatMap((value) => value.split(','))
    .filter((value): value is JobStatus => (JOB_STATUSES as readonly string[]).includes(value));
  const sortParam = params.get('sort');
  const sort = JOB_SORTS.find((s) => s === sortParam) ?? DEFAULT_SORT;
  return {
    status: [...new Set(status)],
    q: params.get('q') ?? '',
    hotFolderId: params.get('hotFolderId') ?? '',
    deviceId: params.get('deviceId') ?? '',
    sort,
  };
}

export function writeJobFilters(filters: JobFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const status of filters.status) params.append('status', status);
  if (filters.q) params.set('q', filters.q);
  if (filters.hotFolderId) params.set('hotFolderId', filters.hotFolderId);
  if (filters.deviceId) params.set('deviceId', filters.deviceId);
  if (filters.sort !== DEFAULT_SORT) params.set('sort', filters.sort);
  return params;
}

export function toListFilters(filters: JobFilters): JobListFilters {
  return {
    status: filters.status.length ? filters.status : undefined,
    q: filters.q.trim() || undefined,
    hotFolderId: filters.hotFolderId || undefined,
    deviceId: filters.deviceId || undefined,
    sort: filters.sort,
  };
}

export function parseSort(sort: JobSort): { field: SortField; desc: boolean } {
  const desc = sort.startsWith('-');
  return { field: (desc ? sort.slice(1) : sort) as SortField, desc };
}

export function nextSort(current: JobSort, field: SortField): JobSort {
  const { field: currentField, desc } = parseSort(current);
  const nextDesc = currentField === field ? !desc : DEFAULT_DESC[field];
  return (nextDesc ? `-${field}` : field) as JobSort;
}
