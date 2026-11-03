import { useConnectionState } from '../live/LiveProvider';
import { strings } from '../strings';
import styles from './ConnectionIndicator.module.css';

export function ConnectionIndicator() {
  const state = useConnectionState();
  return (
    <span className={styles.indicator} data-state={state} role="status" aria-label={strings.connection.label}>
      <span className={styles.dot} aria-hidden="true" />
      {strings.connection[state]}
    </span>
  );
}
