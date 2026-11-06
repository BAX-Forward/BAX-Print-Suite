import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
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
import { INLINE_ERRORS, queryKeys, useJobList } from '../api/queries';
import type { Job, JobPatch } from '../api/types';
import { clampPriority } from '../components/PriorityControl';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toasts';
import ui from '../components/ui.module.css';
import { formatBytes, formatDateTime } from '../lib/format';
import { strings } from '../strings';
import styles from './JobsPage.module.css';

/** Spec 002: virtualize rows past 200 items. */
export const VIRTUALIZE_THRESHOLD = 200;
const ROW_HEIGHT_PX = 41;
const VIRTUAL_OVERSCAN_ROWS = 10;
const DEFAULT_BULK_PRIORITY = 50;

const t = strings.jobs;
const column = createColumnHelper<Job>();

/** Total bytes of a job's source files. */
export function sourceBytes(job: Job): number {
  return job.sourceFiles.reduce((total, file) => total + file.sizeBytes, 0);
}

/**
 * Only columns the 052a Job carries. GET /jobs takes no filter or sort parameters (Spec 052a), so the
 * list has no filter controls and no sortable headers: it is always the server's newest-first order.
 */
function buildColumns() {
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
    column.display({
      id: 'sourceFile',
      header: t.columns.sourceFile,
      cell: ({ row }) => row.original.sourceFiles[0]?.name ?? strings.common.none,
    }),
    column.display({
      id: 'fileSize',
      header: t.columns.fileSize,
      cell: ({ row }) => (row.original.sourceFiles.length ? formatBytes(sourceBytes(row.original)) : strings.common.none),
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
  const jobsQuery = useJobList();
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [bulkPriority, setBulkPriority] = useState(DEFAULT_BULK_PRIORITY);
  const scrollRef = useRef<HTMLDivElement>(null);

  const jobs = useMemo(() => jobsQuery.data?.pages.flatMap((page) => page.items) ?? [], [jobsQuery.data]);
  const columns = useMemo(() => buildColumns(), []);

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

  return (
    <>
      <h1>{t.title}</h1>

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
                    {group.headers.map((header) => (
                      <th key={header.id} scope="col">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
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
