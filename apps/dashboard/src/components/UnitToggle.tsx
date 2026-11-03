import { useId } from 'react';
import type { LengthUnit } from '../lib/format';
import { strings } from '../strings';
import ui from './ui.module.css';

const UNITS: { value: LengthUnit; label: string }[] = [
  { value: 'in', label: strings.common.inches },
  { value: 'mm', label: strings.common.millimetres },
];

export function UnitToggle({ unit, onChange }: { unit: LengthUnit; onChange: (unit: LengthUnit) => void }) {
  const name = useId();
  return (
    <fieldset className={ui.fieldset}>
      <legend>{strings.common.units}</legend>
      <div className={ui.inlineGroup}>
        {UNITS.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={unit === option.value}
              onChange={() => onChange(option.value)}
            />{' '}
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
