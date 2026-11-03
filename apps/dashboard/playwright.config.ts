import { defineConfig, devices } from '@playwright/test';

/**
 * Mock-mode smoke tests (Spec 002 acceptance 7): the UI runs entirely on MSW via `dev:mock`.
 * The full e2e suite against a real server (acceptance 6) arrives with the server work.
 */

const PORT = 5174;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const isCi = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  reporter: isCi ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: ORIGIN, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Extra arguments are appended to the last command of the script, i.e. `vite --mode mock`.
    command: `pnpm run dev:mock --port ${PORT} --strictPort`,
    url: `${ORIGIN}/ui/`,
    reuseExistingServer: !isCi,
    timeout: 120_000,
  },
});
