import { useCallback, useState } from 'react';
import type { LengthUnit } from './format';

const STORAGE_KEY = 'bps.lengthUnit';

function readStored(): LengthUnit {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'mm' ? 'mm' : 'in';
  } catch {
    return 'in';
  }
}

export function useUnitPreference(): [LengthUnit, (unit: LengthUnit) => void] {
  const [unit, setUnitState] = useState<LengthUnit>(readStored);
  const setUnit = useCallback((next: LengthUnit) => {
    setUnitState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice still applies to this view.
    }
  }, []);
  return [unit, setUnit];
}
