import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, errorMessage } from '../api/client';
import { useDevices, useJob, usePatchJob, usePrintJob, useTransitions } from '../api/queries';
import type { Job, JobStatus } from '../api/types';
import { PriorityControl } from '../components/PriorityControl';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toasts';
import ui from '../components/ui.module.css';
import { formatBytes, formatDateTime } from '../lib/format';
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
      <JobActions job={job} />
      <JobDetails job={job} />
    </>
  );
}

function JobActions({ job }: { job: Job }) {
  const toast = useToast();
  const transitions = useTransitions(job.id);
  const devices = useDevices();
  const patch = usePatchJob();
  const print = usePrintJob();
  const [selectedDevice, setSelectedDevice] = useState('');

  // Use the answer only if it describes the job's current status (it is refetched after every change).
  const allowed = transitions.data?.status === job.status ? transitions.data.allowed : [];
  const busy = patch.isPending || print.isPending;
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
          <select id="job-device" value={selectedDevice} onChange={(event) => setSelectedDevice(event.target.value)}>
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

/** The fields of the 052a Job (GET /jobs/:id); its first source file is the uploaded or ingested PDF. */
function JobDetails({ job }: { job: Job }) {
  const source = job.sourceFiles[0];
  const none = strings.common.none;
  const f = t.fields;

  const rows: [string, React.ReactNode][] = [
    [f.id, <code key="id">{job.id}</code>],
    [f.status, <StatusBadge key="status" status={job.status} />],
    [f.priority, job.priority],
    [f.format, job.sourceFormat ?? none],
    [f.source, source ? <code key="src">{source.name}</code> : none],
    [f.fileSize, source ? formatBytes(source.sizeBytes) : none],
    [f.sha256, source ? <code key="sha">{source.sha256}</code> : none],
    [f.lifecycle, job.lifecycle ?? none],
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
