import type { DeviceState, JobStatus, StepStatus } from '../api/types';
import { strings } from '../strings';
import ui from './ui.module.css';

type Tone = 'neutral' | 'info' | 'progress' | 'success' | 'danger';

/** Visual grouping only; the label always carries the meaning (color is never the sole cue). */
const JOB_TONE: Record<JobStatus, Tone> = {
  received: 'neutral',
  inspecting: 'progress',
  ready: 'info',
  held: 'neutral',
  queued: 'info',
  processing: 'progress',
  sent_to_device: 'success',
  printed: 'success',
  done: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

const STEP_TONE: Record<StepStatus, Tone> = {
  pending: 'neutral',
  running: 'progress',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

const DEVICE_TONE: Record<DeviceState, Tone> = {
  ready: 'success',
  busy: 'progress',
  offline: 'danger',
  unknown: 'neutral',
};

function Badge({ tone, label, value }: { tone: Tone; label: string; value: string }) {
  return (
    <span className={ui.badge} data-tone={tone} data-status={value}>
      {label}
    </span>
  );
}

export function StatusBadge({ status }: { status: JobStatus }) {
  return <Badge tone={JOB_TONE[status]} label={strings.status[status]} value={status} />;
}

export function StepStatusBadge({ status }: { status: StepStatus }) {
  return <Badge tone={STEP_TONE[status]} label={strings.stepStatus[status]} value={status} />;
}

export function DeviceStateBadge({ state }: { state: DeviceState }) {
  return <Badge tone={DEVICE_TONE[state]} label={strings.deviceState[state]} value={state} />;
}
