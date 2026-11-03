import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEVICE_IDS, HOT_FOLDER_IDS } from '../mock/fixtures';
import { strings } from '../src/strings';
import { installMockServer, renderApp, useMockDb } from './helpers';

/** Spec 002 Part B, screen 4 (Hot folders) against the MSW mock API. */

const t = strings.hotFolders;
const f = t.fields;

installMockServer();

async function renderHotFolders() {
  const db = useMockDb();
  const view = renderApp('/hotfolders', db);
  await screen.findByRole('table', { name: t.caption });
  return { db, ...view };
}

function folderRow(container: HTMLElement, id: string) {
  const row = container.querySelector<HTMLElement>(`tr[data-hotfolder-id="${id}"]`);
  if (!row) throw new Error(`No row for ${id}`);
  return within(row);
}

/** Labels of required fields end with an aria-hidden "*". */
const pathInput = () => screen.getByRole('textbox', { name: new RegExp(`^${f.path}`) });

describe('Hot folder list', () => {
  it('lists folders with their settings and state', async () => {
    const { container } = await renderHotFolders();
    const banners = folderRow(container, HOT_FOLDER_IDS.banners);
    expect(banners.getByRole('rowheader', { name: 'Banners' })).toBeInTheDocument();
    expect(banners.getByText('/srv/print/hot/banners')).toBeInTheDocument();
    expect(banners.getByText('Roll printer A')).toBeInTheDocument();
    expect(banners.getByText(t.enabled)).toBeInTheDocument();
    expect(banners.getByText(t.defaultProcessed)).toBeInTheDocument();

    const posters = folderRow(container, HOT_FOLDER_IDS.posters);
    expect(posters.getByText('*.pdf, *.PDF')).toBeInTheDocument();

    const archive = folderRow(container, HOT_FOLDER_IDS.archive);
    expect(archive.getByText(t.disabled)).toBeInTheDocument();
    expect(archive.getByText('/srv/print/done/archive')).toBeInTheDocument();
    expect(screen.getByText(t.removeNote)).toBeInTheDocument();
  });
});

describe('Add hot folder', () => {
  it('adds a folder with all options', async () => {
    const { container, user, db } = await renderHotFolders();
    await user.type(pathInput(), '/srv/print/hot/wraps');
    const patterns = screen.getByRole('textbox', { name: f.patterns });
    await user.clear(patterns);
    await user.type(patterns, '*.pdf, *.ai');
    const priority = screen.getByRole('spinbutton', { name: f.priority });
    await user.clear(priority);
    await user.type(priority, '70');
    await user.click(screen.getByRole('checkbox', { name: f.dedupe }));
    await user.type(screen.getByRole('textbox', { name: f.processed }), '/srv/print/done/wraps');
    await user.selectOptions(screen.getByRole('combobox', { name: f.device }), 'Roll printer A');
    await user.click(screen.getByRole('button', { name: t.add }));

    await screen.findByText(t.added('wraps'));
    const created = db.listHotFolders().find((folder) => folder.path === '/srv/print/hot/wraps');
    expect(created).toMatchObject({
      name: 'wraps',
      enabled: true,
      settings: {
        filePatterns: ['*.pdf', '*.ai'],
        defaultPriority: 70,
        dedupe: false,
        moveProcessedTo: '/srv/print/done/wraps',
        defaultDeviceId: DEVICE_IDS.rollA,
      },
    });
    await waitFor(() => expect(container.querySelector(`tr[data-hotfolder-id="${created?.id}"]`)).not.toBeNull());
    expect(pathInput()).toHaveValue(''); // form reset
  });

  it('accepts Windows paths and a custom name', async () => {
    const { user, db } = await renderHotFolders();
    await user.type(pathInput(), 'D:\\Hot\\Wraps');
    await user.type(screen.getByRole('textbox', { name: f.name }), 'Vehicle wraps');
    await user.click(screen.getByRole('button', { name: t.add }));
    await screen.findByText(t.added('Vehicle wraps'));
    expect(db.listHotFolders().some((folder) => folder.path === 'D:\\Hot\\Wraps')).toBe(true);
  });

  it('shows server-side path validation errors inline', async () => {
    const { user, db } = await renderHotFolders();
    await user.type(pathInput(), 'relative/folder');
    await user.click(screen.getByRole('button', { name: t.add }));

    await waitFor(() => expect(pathInput()).toHaveAttribute('aria-invalid', 'true'));
    expect(pathInput()).toHaveAccessibleDescription(expect.stringContaining('The path must be absolute on the server.'));
    expect(db.listHotFolders()).toHaveLength(3);

    await user.clear(pathInput());
    await user.type(pathInput(), '/srv/print/hot/banners/');
    await user.click(screen.getByRole('button', { name: t.add }));
    await waitFor(() =>
      expect(pathInput()).toHaveAccessibleDescription(expect.stringContaining('This folder is already watched.')),
    );
  });

  it('shows errors for settings next to their fields', async () => {
    const { user } = await renderHotFolders();
    await user.type(pathInput(), '/srv/print/hot/empty-patterns');
    await user.clear(screen.getByRole('textbox', { name: f.patterns }));
    await user.click(screen.getByRole('button', { name: t.add }));
    const patterns = screen.getByRole('textbox', { name: f.patterns });
    await waitFor(() => expect(patterns).toHaveAttribute('aria-invalid', 'true'));
    expect(patterns).toHaveAccessibleDescription(expect.stringContaining('Enter at least one file pattern'));
    expect(pathInput()).not.toHaveAttribute('aria-invalid');
  });
});

describe('Enable, disable and remove', () => {
  it('disables a folder, which stops ingestion, and enables it again', async () => {
    const { container, user, db } = await renderHotFolders();
    await user.click(screen.getByRole('button', { name: t.disable('Posters') }));
    await waitFor(() => expect(folderRow(container, HOT_FOLDER_IDS.posters).getByText(t.disabled)).toBeInTheDocument());
    expect(db.ingest({ hotFolderId: HOT_FOLDER_IDS.posters })).toBeNull();

    await user.click(screen.getByRole('button', { name: t.enable('Posters') }));
    await waitFor(() => expect(folderRow(container, HOT_FOLDER_IDS.posters).getByText(t.enabled)).toBeInTheDocument());
    expect(db.ingest({ hotFolderId: HOT_FOLDER_IDS.posters })).not.toBeNull();
  });

  it('removes a folder only after confirmation', async () => {
    const { container, user, db } = await renderHotFolders();
    await user.click(screen.getByRole('button', { name: t.removeLabel('Archive reprints') }));
    const row = folderRow(container, HOT_FOLDER_IDS.archive);
    await user.click(row.getByRole('button', { name: t.keep }));
    expect(db.listHotFolders()).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: t.removeLabel('Archive reprints') }));
    await user.click(folderRow(container, HOT_FOLDER_IDS.archive).getByRole('button', { name: t.confirmRemove }));
    await screen.findByText(t.removed('Archive reprints'));
    await waitFor(() => expect(container.querySelector(`tr[data-hotfolder-id="${HOT_FOLDER_IDS.archive}"]`)).toBeNull());
    expect(db.listHotFolders().map((folder) => folder.id)).not.toContain(HOT_FOLDER_IDS.archive);
  });
});
