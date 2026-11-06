import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Smoke test of `pnpm --filter dashboard dev:mock` (Spec 002 acceptance 7), plus the axe check of
 * acceptance 8 on the mock UI. Strings are literal on purpose: this checks what operators see.
 */

const FIXTURE_JOBS = 14;
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

const jobRows = (page: Page) => page.locator('tr[data-job-id]');

async function expectNoSeriousA11yViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocking = results.violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
  expect(blocking).toEqual([]);
}

// GET /jobs takes only limit and cursor (Spec 052a), so the list has no filter or search controls.
test('jobs list runs on the mock API with live updates', async ({ page }) => {
  await page.goto('/ui/');
  await expect(page).toHaveURL(/\/ui\/jobs$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Jobs' })).toBeVisible();
  await expect(jobRows(page)).toHaveCount(FIXTURE_JOBS);
  await expect(page.getByRole('status', { name: 'Live updates' })).toHaveAttribute('data-state', 'open');
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
});

test('job detail renders non-blank screen-preview thumbnails with pdf.js', async ({ page }) => {
  await page.goto('/ui/jobs');
  await page.getByRole('link', { name: 'brochure-a4-3pages', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'brochure-a4-3pages' })).toBeVisible();

  const first = page.getByRole('img', { name: 'Screen preview of page 1' });
  await expect(first).toBeVisible();
  const size = await first.evaluate((canvas: HTMLCanvasElement) => ({ width: canvas.width, height: canvas.height }));
  expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(320);

  // The fixture pages are white with a coloured panel, so some pixel must differ from white.
  const coloured = await first.evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!data) return 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) count += 1;
    return count;
  });
  expect(coloured).toBeGreaterThan(0);
  await expectNoSeriousA11yViolations(page);
});

test('hot folders page shows an inline path error from the mock server', async ({ page }) => {
  await page.goto('/ui/hotfolders');
  await expect(page.getByRole('heading', { level: 1, name: 'Hot folders' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  const path = page.getByRole('textbox', { name: /^Folder path/ });
  await path.fill('relative/folder');
  await page.getByRole('button', { name: 'Add hot folder' }).click();
  await expect(path).toHaveAttribute('aria-invalid', 'true');
});
