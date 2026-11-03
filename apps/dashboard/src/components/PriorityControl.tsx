import { useId, useState } from 'react';
import { strings } from '../strings';
import ui from './ui.module.css';

export const MIN_PRIORITY = 0;
export const MAX_PRIORITY = 100;

export function clampPriority(value: number): number {
  if (!Number.isFinite(value)) return MIN_PRIORITY;
  return Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, Math.round(value)));
}

/** Slider and number input kept in sync; the value is sent only on "Set priority". */
export function PriorityControl({
  initial,
  busy,
  onSave,
}: {
  initial: number;
  busy?: boolean;
  onSave: (priority: number) => void;
}) {
  const [value, setValue] = useState(initial);
  const id = useId();
  const update = (raw: string) => setValue(clampPriority(Number(raw)));

  return (
    <div className={ui.inlineGroup}>
      <label htmlFor={`${id}-number`} className={ui.fieldLabel}>
        {strings.jobDetail.priorityLabel}
      </label>
      <input
        type="range"
        min={MIN_PRIORITY}
        max={MAX_PRIORITY}
        value={value}
        aria-label={strings.jobDetail.prioritySlider}
        onChange={(event) => update(event.target.value)}
      />
      <input
        id={`${id}-number`}
        type="number"
        min={MIN_PRIORITY}
        max={MAX_PRIORITY}
        step={1}
        value={value}
        onChange={(event) => update(event.target.value)}
        style={{ width: '5em' }}
      />
      <button type="button" disabled={busy || value === initial} onClick={() => onSave(value)}>
        {strings.jobDetail.setPriority}
      </button>
    </div>
  );
}
