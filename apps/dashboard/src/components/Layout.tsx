import { NavLink, Outlet } from 'react-router-dom';
import { strings } from '../strings';
import { ConnectionIndicator } from './ConnectionIndicator';
import styles from './Layout.module.css';

const NAV_ITEMS = [
  { to: '/jobs', label: strings.nav.jobs },
  { to: '/hotfolders', label: strings.nav.hotFolders },
  { to: '/devices', label: strings.nav.devices },
];

export function Layout() {
  return (
    <div className={styles.app}>
      <a href="#main" className={styles.skipLink}>
        {strings.skipToContent}
      </a>
      <header className={styles.header}>
        <span className={styles.brand}>{strings.appName}</span>
        <nav aria-label={strings.nav.label}>
          <ul className={styles.nav}>
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} className={styles.navLink}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <ConnectionIndicator />
      </header>
      <main id="main" tabIndex={-1} className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
