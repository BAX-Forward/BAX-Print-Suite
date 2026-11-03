import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, errorMessage } from '../api/client';
import { useDevices, useHotFolders, useJob, usePatchJob, usePrintJob, useTransitions } from '../api/queries';
import type { Job, JobStatus, JobStep } from '../api/types';
import { PriorityControl } from '../components/PriorityControl';
import { StatusBadge, StepStatusBadge } from '../components/StatusBadge';
import { Thumbnail } from '../components/Thumbnail';
import { useToast } from '../components/Toasts';
import ui from '../components/ui.module.css';
import { UnitToggle } from '../components/UnitToggle';
import { formatBox, formatBytes, formatDateTime, formatPageSize } from '../lib/format';
import { buildTimeline, deliveredPath } from '../lib/timeline';
import { useUnitPreference } from '../lib/useUnitPreference';
import { strings } from '../strings';
import styles from './JobDetailPage.module.css';

const t = strings.jobDetail;

/** Status buttons offered on the detail screen; each is enabled only if `/transitions` allows it. */
const STATUS_ACTIONS = Object.keys(t.actions) as JobStatus[];
/** Sending queues the job and starts output, so it needs one of these transitions to be allowed. */
const SEND_VIA: readonly JobStatus[] = ['queued', 'processing'];

export function JobDetailPage() {
  const { id = '' } = useParams();
  const jobQuery = useJob(id);

  if (jobQuery.isPending) return <p>{t.loadingJob}</p>;
  if (jobQuery.isError) {
    const notFound = jobQuery.error instanceof ApiError && jobQuery.error.status === 404;
    return (
      <>
        <h1>{notFound ? t.notFound : strings.errors.loadFailed('the job')}</h1>
        {!notFound && <p className={ui.error}>{errorMessage(jobQuery.error)}</p>}
        <Link to="/jobs">{strings.common.backToJobs}</Link>
      </>
    );
  }

  const job = jobQuery.data;
  return (
    <>
      <p>
        <Link to="/jobs">{strings.common.backToJobs}</Link>
      </p>
      <h1>{job.name}</h1>
      {job.status === 'failed' && <ErrorPanel job={job} />}
      <JobActions job={job} />
      <JobDetails job={job} />
      <PagesSection job={job} />
      <Timeline job={job} />
    </>
  );
}

function ErrorPanel({ job }: { job: Job }) {
  const error = job.error ?? [...job.steps].reverse().find((step) => step.error)?.error ?? null;
  return (
    <section className={styles.errorPanel} aria-labelledby="job-error-heading">
      <h2 id="job-error-heading">{t.errorHeading}</h2>
      {error ? (
        <>
          <p>
            <strong>{error.message}</strong> <code>{error.code}</code>
          </p>
          {error.detail && <p>{error.detail}</p>}
        </>
      ) : (
        <p>{strings.errors.unknown}</p>
      )}
    </section>
  );
}

function JobActions({ job }: { job: Job }) {
  const toast = useToast();
  const transitions = useTransitions(job.id);
  const devices = useDevices();
  const patch = usePatchJob();
  const print = usePrintJob();
  const [deviceChoice, setDeviceChoice] = useState<string | null>(null);

  // Use the answer only if it describes the job's current status (it is refetched after every change).
  const allowed = transitions.data?.status === job.status ? transitions.data.allowed : [];
  const busy = patch.isPending || print.isPending;
  const selectedDevice = deviceChoice ?? job.deviceId ?? '';
  const canSend = allowed.some((status) => SEND_VIA.includes(status));

  const changeStatus = (status: JobStatus) =>
    patch.mutate(
      { id: job.id, patch: { status } },
      { onSuccess: () => toast.success(t.statusChanged(strings.status[status])) },
    );

  const send = () => {
    const device = devices.data?.find((d) => d.id === selectedDevice);
    print.mutate(
      { id: job.id, deviceId: selectedDevice },
      { onSuccess: () => toast.success(t.sentToDevice(device?.name ?? selectedDevice)) },
    );
  };

  return (
    <section aria-labelledby="job-actions-heading">
      <h2 id="job-actions-heading">{t.actionsHeading}</h2>
      <div className={styles.actions}>
        <div role="group" aria-label={t.statusActions} className={ui.inlineGroup}>
          {STATUS_ACTIONS.map((status) => (
            <button
              key={status}
              type="button"
              className={status === 'cancelled' ? 'danger' : undefined}
              disabled={busy || !allowed.includes(status)}
              onClick={() => changeStatus(status)}
            >
              {t.actions[status]}
            </button>
          ))}
        </div>
        <PriorityControl
          key={`${job.id}-${job.priority}`}
          initial={job.priority}
          busy={busy}
          onSave={(priority) =>
            patch.mutate(
              { id: job.id, patch: { priority } },
              { onSuccess: () => toast.success(t.priorityChanged(priority)) },
            )
          }
        />
        <div className={ui.inlineGroup}>
          <label htmlFor="job-device" className={ui.fieldLabel}>
            {t.device}
          </label>
          <select id="job-device" value={selectedDevice} onChange={(event) => setDeviceChoice(event.target.value)}>
            <option value="">{t.chooseDevice}</option>
            {(devices.data ?? []).map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
          <button type="button" disabled={busy || !canSend || !selectedDevice} onClick={send}>
            {t.sendToDevice}
          </button>
        </div>
      </div>
    </section>
  );
}

function JobDetails({ job }: { job: Job }) {
  const hotFolders = useHotFolders();
  const devices = useDevices();
  const hotFolder = job.hotFolderId ? hotFolders.data?.find((f) => f.id === job.hotFolderId) : undefined;
  const device = job.deviceId ? devices.data?.find((d) => d.id === job.deviceId) : undefined;
  const delivered = deliveredPath(job);
  const none = strings.common.none;
  const f = t.fields;

  const rows: [string, React.ReactNode][] = [
    [f.id, <code key="id">{job.id}</code>],
    [f.status, <StatusBadge key="status" status={job.status} />],
    [f.priority, job.priority],
    [f.pages, job.pageCount],
    [f.fileSize, formatBytes(job.sizeBytes)],
    [f.sha256, <code key="sha">{job.sha256}</code>],
    [f.source, job.sourcePath ? <code key="src">{job.sourcePath}</code> : none],
    [f.hotFolder, job.hotFolderId ? (hotFolder?.name ?? job.hotFolderId) : none],
    [f.device, job.deviceId ? (device?.name ?? job.deviceId) : none],
    [f.deliveredTo, delivered ? <code key="delivered">{delivered}</code> : none],
    [f.created, formatDateTime(job.createdAt)],
    [f.updated, formatDateTime(job.updatedAt)],
  ];

  return (
    <section aria-labelledby="job-details-heading">
      <h2 id="job-details-heading">{t.detailsHeading}</h2>
      <dl className={styles.details}>
        {rows.map(([label, value]) => (
          <div key={label} className={styles.detailRow}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function PagesSection({ job }: { job: Job }) {
  const [unit, setUnit] = useUnitPreference();
  return (
    <section aria-labelledby="job-pages-heading">
      <h2 id="job-pages-heading">{t.pagesHeading}</h2>
      <div className={ui.toolbar}>
        <UnitToggle unit={unit} onChange={setUnit} />
        <p className={ui.hint}>{t.previewNote}</p>
      </div>
      {job.pages.length === 0 ? (
        <p className={ui.muted}>{strings.common.none}</p>
      ) : (
        <table className={ui.table}>
          <caption className="visually-hidden">{t.pagesCaption}</caption>
          <thead>
            <tr>
              <th scope="col">{t.page}</th>
              <th scope="col">{t.size}</th>
              <th scope="col">{t.trimBox}</th>
              <th scope="col">{t.preview}</th>
            </tr>
          </thead>
          <tbody>
            {job.pages.map((page) => (
              <tr key={page.index} data-page-index={page.index}>
                <th scope="row">{page.index + 1}</th>
                <td>{formatPageSize(page.widthPt, page.heightPt, unit)}</td>
                <td>{page.trimBox ? formatBox(page.trimBox, unit) : strings.common.none}</td>
                <td>
                  <Thumbnail jobId={job.id} pageIndex={page.index} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function StepResult({ step }: { step: JobStep }) {
  const result = step.result;
  if (!result) return null;
  const r = t.stepResult;
  const entries: [string, string][] = [];
  if (typeof result.deliveredPath === 'string') entries.push([r.deliveredPath, result.deliveredPath]);
  if (typeof result.bytes === 'number') entries.push([r.bytes, formatBytes(result.bytes)]);
  if (typeof result.sha256 === 'string') entries.push([r.sha256, result.sha256]);
  if (!entries.length) return null;
  return (
    <dl className={styles.stepResult}>
      {entries.map(([label, value]) => (
        <div key={label} className={styles.detailRow}>
          <dt>{label}</dt>
          <dd>
            <code>{value}</code>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Timeline({ job }: { job: Job }) {
  const items = buildTimeline(job);
  return (
    <section aria-labelledby="job-timeline-heading">
      <h2 id="job-timeline-heading">{t.timelineHeading}</h2>
      {items.length === 0 ? (
        <p className={ui.muted}>{t.noTimeline}</p>
      ) : (
        <ol className={styles.timeline}>
          {items.map((item) => (
            <li key={item.key} data-kind={item.kind}>
              <time dateTime={item.time || undefined} className={ui.muted}>
                {formatDateTime(item.time)}
              </time>{' '}
              {item.kind === 'step' ? (
                <>
                  <strong>{t.step(item.step.stage)}</strong> <StepStatusBadge status={item.step.status} />
                  {item.step.error && (
                    <p className={ui.error}>
                      {item.step.error.message} <code>{item.step.error.code}</code>
                    </p>
                  )}
                  <StepResult step={item.step} />
                </>
              ) : (
                <span>{item.entry.message}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
