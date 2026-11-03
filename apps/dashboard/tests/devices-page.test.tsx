import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEVICE_IDS, PLUGIN_IDS } from '../mock/fixtures';
import { strings } from '../src/strings';
import { installMockServer, renderApp, useMockDb } from './helpers';

/** Spec 002 Part B, screen 5 (Devices) and the config form generated from `configSchema`. */

const t = strings.devices;
const f = t.fields;

installMockServer();

async function renderDevices() {
  const db = useMockDb();
  const view = renderApp('/devices', db);
  await screen.findByRole('table', { name: t.caption });
  await screen.findByRole('combobox', { name: new RegExp(`^${f.driver}`) });
  return { db, ...view };
}

function deviceRow(container: HTMLElement, id: string) {
  const row = container.querySelector<HTMLElement>(`tr[data-device-id="${id}"]`);
  if (!row) throw new Error(`No row for ${id}`);
  return within(row);
}

/** Labels of required fields end with an aria-hidden "*". */
const nameInput = () => screen.getByRole('textbox', { name: new RegExp(`^${f.name}`) });
const driverSelect = () => screen.getByRole('combobox', { name: new RegExp(`^${f.driver}`) });
const targetDirInput = () => screen.getByRole('textbox', { name: /^Target hot folder/ });

describe('Device list', () => {
  it('shows devices with driver, status, auto-dispatch and config', async () => {
    const { container } = await renderDevices();
    const roll = deviceRow(container, DEVICE_IDS.rollA);
    expect(roll.getByRole('rowheader', { name: 'Roll printer A' })).toBeInTheDocument();
    expect(roll.getByText('Hot-folder handoff')).toBeInTheDocument();
    expect(roll.getByText(strings.deviceState.ready)).toBeInTheDocument();
    expect(roll.getByText(strings.common.no)).toBeInTheDocument();
    expect(roll.getByText('/srv/rip/in/roll-a')).toBeInTheDocument();
  });

  it('turns auto-dispatch on and off', async () => {
    const { container, user, db } = await renderDevices();
    await user.click(screen.getByRole('button', { name: t.enableAuto('Roll printer A') }));
    await waitFor(() => expect(deviceRow(container, DEVICE_IDS.rollA).getByText(strings.common.yes)).toBeInTheDocument());
    expect(db.listDevices()[0].autoDispatch).toBe(true);

    await user.click(screen.getByRole('button', { name: t.disableAuto('Roll printer A') }));
    await waitFor(() => expect(deviceRow(container, DEVICE_IDS.rollA).getByText(strings.common.no)).toBeInTheDocument());
    expect(db.listDevices()[0].autoDispatch).toBe(false);
  });
});

describe('Add device', () => {
  it('offers only installed printer driver plugins (GET /plugins)', async () => {
    await renderDevices();
    const values = within(driverSelect())
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);
    expect(values).toEqual(['', PLUGIN_IDS.handoff, PLUGIN_IDS.mock]);
    expect(screen.queryByRole('group', { name: f.configHeading })).not.toBeInTheDocument();
  });

  it('renders the config form from the plugin JSON Schema with its defaults', async () => {
    const { user } = await renderDevices();
    await user.selectOptions(driverSelect(), PLUGIN_IDS.handoff);

    const config = within(screen.getByRole('group', { name: f.configHeading }));
    expect(targetDirInput()).toHaveValue('');
    expect(targetDirInput()).toHaveAccessibleDescription('Absolute path of the folder the external RIP watches.');
    expect(config.getByRole('textbox', { name: 'File name pattern' })).toHaveValue('{jobName}_{jobId}.pdf');
    expect(config.getByRole('combobox', { name: 'If the file already exists' })).toHaveValue('suffix');
    expect(config.getByRole('checkbox', { name: 'Write the job ticket next to the PDF ({base}.json)' })).not.toBeChecked();
    expect(config.getByRole('checkbox', { name: 'Verify size and SHA-256 after copying' })).toBeChecked();
  });

  it('switches the form when another driver is chosen', async () => {
    const { user } = await renderDevices();
    await user.selectOptions(driverSelect(), PLUGIN_IDS.handoff);
    await user.selectOptions(driverSelect(), PLUGIN_IDS.mock);

    expect(screen.queryByRole('textbox', { name: /^Target hot folder/ })).not.toBeInTheDocument();
    const band = screen.getByRole('spinbutton', { name: 'Band height (px)' });
    expect(band).toHaveValue(256);

    await user.clear(band);
    await user.type(band, '8');
    await user.type(nameInput(), 'Test bands');
    await user.click(screen.getByRole('button', { name: t.add }));
    expect(band).toHaveAttribute('aria-invalid', 'true');
    expect(band).toHaveAccessibleDescription(strings.form.min(16));
  });

  it('adds a handoff device and shows it in the list', async () => {
    const { container, user, db } = await renderDevices();
    await user.type(nameInput(), 'Roll printer B');
    await user.selectOptions(driverSelect(), PLUGIN_IDS.handoff);
    await user.click(screen.getByRole('checkbox', { name: f.autoDispatch }));
    await user.type(targetDirInput(), '/srv/rip/in/roll-b');
    await user.selectOptions(screen.getByRole('combobox', { name: 'If the file already exists' }), 'overwrite');
    await user.click(screen.getByRole('button', { name: t.add }));

    await screen.findByText(t.added('Roll printer B'));
    const created = db.listDevices().find((device) => device.name === 'Roll printer B');
    expect(created).toMatchObject({
      kind: 'printer',
      pluginId: PLUGIN_IDS.handoff,
      autoDispatch: true,
      config: {
        targetDir: '/srv/rip/in/roll-b',
        fileNamePattern: '{jobName}_{jobId}.pdf',
        conflict: 'overwrite',
        writeTicketSidecar: false,
        verifyAfterCopy: true,
      },
      status: { state: 'ready' },
    });
    await waitFor(() => expect(container.querySelector(`tr[data-device-id="${created?.id}"]`)).not.toBeNull());
    expect(nameInput()).toHaveValue(''); // form reset
    expect(driverSelect()).toHaveValue('');
  });

  it('checks required fields before sending anything', async () => {
    const { user, db } = await renderDevices();
    await user.selectOptions(driverSelect(), PLUGIN_IDS.handoff);
    await user.click(screen.getByRole('button', { name: t.add }));

    expect(nameInput()).toHaveAttribute('aria-invalid', 'true');
    expect(nameInput()).toHaveAccessibleDescription(strings.form.required);
    expect(targetDirInput()).toHaveAttribute('aria-invalid', 'true');
    expect(targetDirInput()).toHaveAccessibleDescription(expect.stringContaining(strings.form.required));
    expect(db.listDevices()).toHaveLength(1);
  });

  it('shows server-side config validation errors next to the generated field', async () => {
    const { user, db } = await renderDevices();
    await user.type(nameInput(), 'Relative target');
    await user.selectOptions(driverSelect(), PLUGIN_IDS.handoff);
    await user.type(targetDirInput(), 'relative/dir');
    await user.click(screen.getByRole('button', { name: t.add }));

    await waitFor(() => expect(targetDirInput()).toHaveAttribute('aria-invalid', 'true'));
    expect(targetDirInput()).toHaveAccessibleDescription(expect.stringContaining('Enter an absolute path on the server.'));
    expect(nameInput()).not.toHaveAttribute('aria-invalid');
    expect(db.listDevices()).toHaveLength(1);
  });

  it('shows a device whose target folder is not writable as offline, with the reason', async () => {
    const { container, user, db } = await renderDevices();
    await user.type(nameInput(), 'Read-only target');
    await user.selectOptions(driverSelect(), PLUGIN_IDS.handoff);
    await user.type(targetDirInput(), '/srv/rip/readonly/in');
    await user.click(screen.getByRole('button', { name: t.add }));

    await screen.findByText(t.added('Read-only target'));
    const created = db.listDevices().find((device) => device.name === 'Read-only target');
    expect(created?.status.state).toBe('offline');
    await waitFor(() => expect(container.querySelector(`tr[data-device-id="${created?.id}"]`)).not.toBeNull());
    const row = deviceRow(container, created?.id ?? '');
    expect(row.getByText(strings.deviceState.offline)).toBeInTheDocument();
    expect(row.getByText('The target folder is not writable.')).toBeInTheDocument();
  });
});
