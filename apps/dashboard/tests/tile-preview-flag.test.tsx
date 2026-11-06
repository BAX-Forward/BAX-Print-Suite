import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fixtureId } from '../mock/fixtures';
import { strings } from '../src/strings';
import { tilePreviewStrings } from '../src/components/tilePreviewStrings';
import { installMockServer, renderApp, useMockDb, waitForLive } from './helpers';

/**
 * Spec 049a: with __BPS_TILE_PREVIEW__ false (the vitest default) the job detail page carries
 * no tile preview markup. JobDetailPage itself is unchanged from main in this slice.
 */

const t = strings.jobDetail;
const READY_JOB = fixtureId(7);

installMockServer();

describe('tile preview flag off', () => {
  it('compiles the constant in as false', () => {
    expect(__BPS_TILE_PREVIEW__).toBe(false);
  });

  it('renders the job detail page without any tile preview markup', async () => {
    const db = useMockDb();
    const { container } = renderApp(`/jobs/${READY_JOB}`, db);
    await screen.findByRole('heading', { level: 1, name: db.getJob(READY_JOB).name });
    await waitForLive();
    expect(await within(screen.getByRole('region', { name: t.detailsHeading })).findByText('Posters')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('img', { name: /^Screen preview of page \d$/ })).toHaveLength(3));

    expect(container.querySelector('[data-tile-preview], [data-panel-id], [data-seam]')).toBeNull();
    expect(screen.queryByRole('img', { name: /^Tile preview/ })).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(tilePreviewStrings.empty);
  });
});
