import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useApi } from '../api/ApiContext';
import { errorMessage } from '../api/client';
import { INLINE_ERRORS, queryKeys, useDevices, useHotFolders, useJobList } from '../api/queries';
import { JOB_STATUSES, type Job, type JobPatch, type SortField } from '../api/types';
import { clampPriority } from '../components/PriorityControl';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toasts';
import ui from '../components/ui.module.css';
import { UnitToggle } from '../components/UnitToggle';
import { formatDateTime, formatPageSize, type LengthUnit } from '../lib/format';
import { nextSort, parseSort, readJobFilters, toListFilters, writeJobFilters, type JobFilters } from '../lib/jobFilters';
import { useUnitPreference } from '../lib/useUnitPreference';
import { strings } from '../strings';
import styles from './JobsPage.module.css';

/** Spec 002: virtualize rows past 200 items. */
export const VIRTUALIZE_THRESHOLD = 200;
const ROW_HEIGHT_PX = 41;
const VIRTUAL_OVERSCAN_ROWS = 10;
const SEARCH_DEBOUNCE_MS = 300;
const DEFAULT_BULK_PRIORITY = 50;

/** Columns the API can sort by (`sort` query parameter). */
const SORTABLE: Record<string, SortField> = { name: 'name', priority: 'priority', createdAt: 'createdAt' };

const t = strings.jobs;
const column = createColumnHelper<Job>();

function buildColumns(
  unit: LengthUnit,
  hotFolderNames: Map<string, string>,
  deviceNames: Map<string, string>,
) {
  // Mixed accessor/display columns need `any` for the value type (TanStack Table's documented pattern).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const columns: ColumnDef<Job, any>[] = [
    column.display({
      id: 'select',
      header: ({ table }) => (
        <input
          type="checkbox"
          aria-label={t.selectAll}
          checked={table.getIsAllRowsSelected()}
          ref={(el) => {
            if (el) el.indeterminate = table.getIsSomeRowsSelected();
          }}
          onChange={table.getToggleAllRowsSelectedHandler()}
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          aria-label={t.selectJob(row.original.name)}
          checked={row.getIsSelected()}
          onChange={row.getToggleSelectedHandler()}
        />
      ),
    }),
    column.accessor('name', {
      header: t.columns.name,
      cell: ({ row }) => <Link to={`/jobs/${encodeURIComponent(row.original.id)}`}>{row.original.name}</Link>,
    }),
    column.accessor('status', { header: t.columns.status, cell: ({ getValue }) => <StatusBadge status={getValue()} /> }),
    column.accessor('priority', { header: t.columns.priority }),
    column.accessor('pageCount', { header: t.columns.pages }),
    column.display({
      id: 'size',
      header: t.columns.size,
      cell: ({ row }) => {
        const first = row.original.pages[0];
        return first ? formatPageSize(first.widthPt, first.heightPt, unit) : strings.common.none;
      },
    }),
    column.display({
      id: 'hotFolder',
      header: t.columns.hotFolder,
      cell: ({ row }) => {
        const hotFolderId = row.original.hotFolderId;
        return hotFolderId ? (hotFolderNames.get(hotFolderId) ?? hotFolderId) : strings.common.none;
      },
    }),
    column.display({
      id: 'device',
      header: t.columns.device,
      cell: ({ row }) => {
        const deviceId = row.original.deviceId;
        return deviceId ? (deviceNames.get(deviceId) ?? deviceId) : strings.common.none;
      },
    }),
    column.accessor('createdAt', { header: t.columns.created, cell: ({ getValue }) => formatDateTime(getValue()) }),
    column.accessor('updatedAt', { header: t.columns.updated, cell: ({ getValue }) => formatDateTime(getValue()) }),
  ];
  return columns;
}

export function JobsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readJobFilters(searchParams), [searchParams]);
  const listFilters = useMemo(() => toListFilters(filters), [filters]);
  const jobsQuery = useJobList(listFilters);
  const hotFolders = useHotFolders();
  const devices = useDevices();
  const [unit, setUnit] = useUnitPreference();
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [searchText, setSearchText] = useState(filters.q);
  const [bulkPriority, setBulkPriority] = useState(DEFAULT_BULK_PRIORITY);
  const scrollRef = useRef<HTMLDivElement>(null);

  const updateFilters = (patch: Partial<JobFilters>) => {
    setSearchParams((prev) => writeJobFilters({ ...readJobFilters(prev), ...patch }), { replace: true });
  };

  useEffect(() => {
    if (searchText === filters.q) return;
    const timer = setTimeout(() => {
      setSearchParams((prev) => writeJobFilters({ ...readJobFilters(prev), q: searchText }), { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText, filters.q, setSearchParams]);

  const jobs = useMemo(() => jobsQuery.data?.pages.flatMap((page) => page.items) ?? [], [jobsQuery.data]);
  const hotFolderNames = useMemo(
    () => new Map((hotFolders.data ?? []).map((folder) => [folder.id, folder.name])),
    [hotFolders.data],
  );
  const deviceNames = useMemo(
    () => new Map((devices.data ?? []).map((device) => [device.id, device.name])),
    [devices.data],
  );
  const columns = useMemo(() => buildColumns(unit, hotFolderNames, deviceNames), [unit, hotFolderNames, deviceNames]);

  const table = useReactTable({
    data: jobs,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (job) => job.id,
    state: { rowSelection },
    onRowSelectionChange: setRowSelection,
    enableRowSelection: true,
  });

  const rows = table.getRowModel().rows;
  const virtualize = rows.length > VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: VIRTUAL_OVERSCAN_ROWS,
  });
  const virtualItems = virtualize ? virtualizer.getVirtualItems() : [];
  const visibleRows = virtualize ? virtualItems.map((item) => rows[item.index]) : rows;
  const paddingTop = virtualize && virtualItems.length ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualize && virtualItems.length ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0;
  const columnCount = table.getVisibleLeafColumns().length;

  const selectedIds = Object.keys(rowSelection).filter((id) => rowSelection[id]);

  const bulk = useMutation({
    mutationFn: async ({ ids, patch }: { ids: string[]; patch: JobPatch }) => {
      const results = await Promise.allSettled(ids.map((id) => api.patchJob(id, patch)));
      return { total: ids.length, failed: results.filter((result) => result.status === 'rejected').length };
    },
    meta: INLINE_ERRORS,
    onSuccess: ({ total, failed }) => {
      if (failed) toast.error(t.bulk.partial(failed, total));
      else toast.success(t.bulk.done(total));
      setRowSelection({});
    },
    onError: (error) => toast.error(errorMessage(error, strings.errors.unknown)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.jobs }),
  });
  const runBulk = (patch: JobPatch) => bulk.mutate({ ids: selectedIds, patch });

  const toggleStatus = (status: (typeof JOB_STATUSES)[number], checked: boolean) => {
    const next = checked ? [...filters.status, status] : filters.status.filter((s) => s !== status);
    updateFilters({ status: next });
  };

  const sort = parseSort(filters.sort);
  const hasFilters = Boolean(filters.status.length || filters.q || filters.hotFolderId || filters.deviceId);

  return (
    <>
      <h1>{t.title}</h1>

      <section aria-label={t.filters} className={ui.toolbar}>
        <fieldset className={ui.fieldset}>
          <legend>{t.statusFilter}</legend>
          <div className={ui.inlineGroup}>
            {JOB_STATUSES.map((status) => (
              <label key={status}>
                <input
                  type="checkbox"
                  checked={filters.status.includes(status)}
                  onChange={(event) => toggleStatus(status, event.target.checked)}
                />{' '}
                {strings.status[status]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className={ui.field}>
          <label htmlFor="jobs-hotfolder">{t.hotFolderFilter}</label>
          <select
            id="jobs-hotfolder"
            value={filters.hotFolderId}
            onChange={(event) => updateFilters({ hotFolderId: event.target.value })}
          >
            <option value="">{t.any}</option>
            {(hotFolders.data ?? []).map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        </div>
        <div className={ui.field}>
          <label htmlFor="jobs-device">{t.deviceFilter}</label>
          <select
            id="jobs-device"
            value={filters.deviceId}
            onChange={(event) => updateFilters({ deviceId: event.target.value })}
          >
            <option value="">{t.any}</option>
            {(devices.data ?? []).map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </div>
        <div className={ui.field}>
          <label htmlFor="jobs-search">{t.search}</label>
          <input
            id="jobs-search"
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </div>
        <UnitToggle unit={unit} onChange={setUnit} />
        {hasFilters && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setSearchText('');
              setSearchParams(writeJobFilters({ ...filters, status: [], q: '', hotFolderId: '', deviceId: '' }), {
                replace: true,
              });
            }}
          >
            {t.clearFilters}
          </button>
        )}
      </section>

      <section aria-label={t.bulk.label} className={ui.toolbar}>
        <span aria-live="polite">{t.bulk.selected(selectedIds.length)}</span>
        <button type="button" disabled={!selectedIds.length || bulk.isPending} onClick={() => runBulk({ status: 'held' })}>
          {t.bulk.hold}
        </button>
        <button type="button" disabled={!selectedIds.length || bulk.isPending} onClick={() => runBulk({ status: 'queued' })}>
          {t.bulk.queue}
        </button>
        <button
          type="button"
          className="danger"
          disabled={!selectedIds.length || bulk.isPending}
          onClick={() => runBulk({ status: 'cancelled' })}
        >
          {t.bulk.cancel}
        </button>
        <span className={ui.inlineGroup}>
          <label htmlFor="jobs-bulk-priority">{t.bulk.priority}</label>
          <input
            id="jobs-bulk-priority"
            type="number"
            min={0}
            max={100}
            value={bulkPriority}
            onChange={(event) => setBulkPriority(clampPriority(Number(event.target.value)))}
            style={{ width: '5em' }}
          />
          <button
            type="button"
            disabled={!selectedIds.length || bulk.isPending}
            onClick={() => runBulk({ priority: bulkPriority })}
          >
            {t.bulk.setPriority}
          </button>
        </span>
      </section>

      {jobsQuery.isPending ? (
        <p>{strings.common.loading}</p>
      ) : jobsQuery.isError ? (
        <p className={ui.error}>{errorMessage(jobsQuery.error, strings.errors.loadFailed('jobs'))}</p>
      ) : (
        <>
          <div ref={scrollRef} className={virtualize ? styles.virtualScroll : styles.scroll} data-virtualized={virtualize}>
            <table className={ui.table}>
              <caption className="visually-hidden">{t.caption}</caption>
              <thead>
                {table.getHeaderGroups().map((group) => (
                  <tr key={group.id}>
                    {group.headers.map((header) => {
                      const sortField = SORTABLE[header.column.id];
                      const content = flexRender(header.column.columnDef.header, header.getContext());
                      const ariaSort = sortField && sort.field === sortField ? (sort.desc ? 'descending' : 'ascending') : undefined;
                      return (
                        <th key={header.id} scope="col" aria-sort={ariaSort}>
                          {sortField ? (
                            <button
                              type="button"
                              className={ui.sortButton}
                              onClick={() => updateFilters({ sort: nextSort(filters.sort, sortField) })}
                            >
                              {content}
                              <span aria-hidden="true">{ariaSort ? (sort.desc ? ' ▼' : ' ▲') : ''}</span>
                            </button>
                          ) : (
                            content
                          )}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {paddingTop > 0 && (
                  <tr aria-hidden="true">
                    <td colSpan={columnCount} style={{ height: paddingTop, padding: 0, border: 0 }} />
                  </tr>
                )}
                {visibleRows.map((row) => (
                  <tr key={row.id} data-job-id={row.id} className={row.getIsSelected() ? styles.selected : undefined}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                    ))}
                  </tr>
                ))}
                {paddingBottom > 0 && (
                  <tr aria-hidden="true">
                    <td colSpan={columnCount} style={{ height: paddingBottom, padding: 0, border: 0 }} />
                  </tr>
                )}
              </tbody>
            </table>
            {jobs.length === 0 && <p className={ui.muted}>{t.empty}</p>}
          </div>
          <div className={ui.toolbar}>
            <span className={ui.muted}>{t.shown(jobs.length)}</span>
            {jobsQuery.hasNextPage && (
              <button
                type="button"
                className="secondary"
                disabled={jobsQuery.isFetchingNextPage}
                onClick={() => void jobsQuery.fetchNextPage()}
              >
                {jobsQuery.isFetchingNextPage ? strings.common.loading : t.loadMore}
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
