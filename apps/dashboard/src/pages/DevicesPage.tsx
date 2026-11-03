import { useId, useMemo, useState, type FormEvent } from 'react';
import { ApiError, errorMessage } from '../api/client';
import { useCreateDevice, useDevices, usePatchDevice, usePlugins } from '../api/queries';
import { isPrinterDriver, type Device, type Plugin } from '../api/types';
import {
  asJsonSchema,
  JsonSchemaForm,
  schemaDefaults,
  validateConfig,
  type ConfigValue,
} from '../components/JsonSchemaForm';
import { DeviceStateBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toasts';
import ui from '../components/ui.module.css';
import { strings } from '../strings';

const t = strings.devices;
const CONFIG_PREFIX = 'config.';

interface ServerErrors {
  name?: string;
  pluginId?: string;
  config: Record<string, string>;
}

/** Splits Problem.errors[] into top-level fields and `config.<key>` fields for the generated form. */
export function serverErrors(error: unknown): ServerErrors {
  const out: ServerErrors = { config: {} };
  if (!(error instanceof ApiError)) return out;
  for (const [field, message] of Object.entries(error.fieldErrors)) {
    if (field.startsWith(CONFIG_PREFIX)) out.config[field.slice(CONFIG_PREFIX.length)] = message;
    else if (field === 'name') out.name = message;
    else if (field === 'pluginId') out.pluginId = message;
  }
  return out;
}

/** Drops empty optional values so the server applies its schema defaults. */
export function compactConfig(value: ConfigValue): ConfigValue {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')),
  );
}

function formatConfigValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function AddDeviceForm({ drivers }: { drivers: Plugin[] }) {
  const toast = useToast();
  const create = useCreateDevice();
  const idPrefix = useId();
  const [name, setName] = useState('');
  const [pluginId, setPluginId] = useState('');
  const [autoDispatch, setAutoDispatch] = useState(false);
  const [config, setConfig] = useState<ConfigValue>({});
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [nameMissing, setNameMissing] = useState(false);
  const f = t.fields;

  const plugin = drivers.find((driver) => driver.id === pluginId);
  const schema = plugin ? asJsonSchema(plugin.configSchema) : null;
  const fromServer = serverErrors(create.error);
  const configErrors = { ...fromServer.config, ...clientErrors };
  const nameError = nameMissing && !name.trim() ? strings.form.required : fromServer.name;

  const chooseDriver = (next: string) => {
    setPluginId(next);
    const nextPlugin = drivers.find((driver) => driver.id === next);
    const nextSchema = nextPlugin ? asJsonSchema(nextPlugin.configSchema) : null;
    setConfig(nextSchema ? schemaDefaults(nextSchema) : {});
    setClientErrors({});
    create.reset();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const errors = schema ? validateConfig(schema, config) : {};
    setClientErrors(errors);
    setNameMissing(!name.trim());
    if (Object.keys(errors).length || !name.trim() || !plugin) return;
    create.mutate(
      { name: name.trim(), kind: 'printer', pluginId: plugin.id, autoDispatch, config: compactConfig(config) },
      {
        onSuccess: (device) => {
          toast.success(t.added(device.name));
          setName('');
          setPluginId('');
          setAutoDispatch(false);
          setConfig({});
          setNameMissing(false);
          create.reset();
        },
      },
    );
  };

  const nameId = `${idPrefix}-name`;
  const driverId = `${idPrefix}-driver`;
  const autoId = `${idPrefix}-auto`;

  return (
    <section aria-labelledby="device-add-heading">
      <h2 id="device-add-heading">{t.addHeading}</h2>
      {drivers.length === 0 ? (
        <p className={ui.muted}>{t.noDrivers}</p>
      ) : (
        <form className={ui.form} onSubmit={submit} noValidate>
          {create.isError && (
            <p className={ui.error} role="alert">
              {errorMessage(create.error, strings.errors.unknown)}
            </p>
          )}
          <div className={ui.field}>
            <label htmlFor={nameId}>
              {f.name}
              <span aria-hidden="true"> *</span>
            </label>
            <input
              id={nameId}
              type="text"
              aria-required="true"
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? `${nameId}-error` : undefined}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            {nameError && (
              <p id={`${nameId}-error`} className={ui.error}>
                {nameError}
              </p>
            )}
          </div>
          <div className={ui.field}>
            <label htmlFor={driverId}>
              {f.driver}
              <span aria-hidden="true"> *</span>
            </label>
            <select
              id={driverId}
              aria-required="true"
              aria-invalid={fromServer.pluginId ? true : undefined}
              aria-describedby={fromServer.pluginId ? `${driverId}-error` : undefined}
              value={pluginId}
              onChange={(event) => chooseDriver(event.target.value)}
            >
              <option value="">{f.chooseDriver}</option>
              {drivers.map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driver.name} ({driver.version})
                </option>
              ))}
            </select>
            {fromServer.pluginId && (
              <p id={`${driverId}-error`} className={ui.error}>
                {fromServer.pluginId}
              </p>
            )}
          </div>
          <div className={ui.checkboxField}>
            <input
              id={autoId}
              type="checkbox"
              checked={autoDispatch}
              onChange={(event) => setAutoDispatch(event.target.checked)}
            />
            <label htmlFor={autoId}>{f.autoDispatch}</label>
          </div>
          {schema && (
            <fieldset className={ui.fieldset}>
              <legend>{f.configHeading}</legend>
              <JsonSchemaForm schema={schema} value={config} onChange={setConfig} errors={configErrors} />
            </fieldset>
          )}
          <div>
            <button type="submit" disabled={create.isPending || !plugin}>
              {create.isPending ? strings.common.loading : t.add}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function DeviceRow({ device, pluginNames }: { device: Device; pluginNames: Map<string, string> }) {
  const patch = usePatchDevice();
  const entries = Object.entries(device.config);

  return (
    <tr data-device-id={device.id}>
      <th scope="row">{device.name}</th>
      <td>{pluginNames.get(device.pluginId) ?? device.pluginId}</td>
      <td>
        <DeviceStateBadge state={device.status.state} />
        {device.status.reason && <p className={ui.hint}>{device.status.reason}</p>}
      </td>
      <td>{device.autoDispatch ? strings.common.yes : strings.common.no}</td>
      <td>
        {entries.length === 0 ? (
          strings.common.none
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1em' }}>
            {entries.map(([key, value]) => (
              <li key={key}>
                {key}: <code>{formatConfigValue(value)}</code>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td>
        <button
          type="button"
          className="secondary"
          disabled={patch.isPending}
          aria-label={device.autoDispatch ? t.disableAuto(device.name) : t.enableAuto(device.name)}
          onClick={() => patch.mutate({ id: device.id, patch: { autoDispatch: !device.autoDispatch } })}
        >
          {device.autoDispatch ? t.turnOff : t.turnOn}
        </button>
      </td>
    </tr>
  );
}

export function DevicesPage() {
  const devices = useDevices();
  const plugins = usePlugins();
  const drivers = useMemo(() => (plugins.data ?? []).filter(isPrinterDriver), [plugins.data]);
  const pluginNames = useMemo(
    () => new Map((plugins.data ?? []).map((plugin) => [plugin.id, plugin.name])),
    [plugins.data],
  );
  const c = t.columns;

  return (
    <>
      <h1>{t.title}</h1>
      {devices.isPending ? (
        <p>{strings.common.loading}</p>
      ) : devices.isError ? (
        <p className={ui.error}>{errorMessage(devices.error, strings.errors.loadFailed('devices'))}</p>
      ) : devices.data.length === 0 ? (
        <p className={ui.muted}>{t.empty}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className={ui.table}>
            <caption className="visually-hidden">{t.caption}</caption>
            <thead>
              <tr>
                {[c.name, c.driver, c.status, c.autoDispatch, c.config, c.actions].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {devices.data.map((device) => (
                <DeviceRow key={device.id} device={device} pluginNames={pluginNames} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {plugins.isPending ? (
        <p>{strings.common.loading}</p>
      ) : plugins.isError ? (
        <p className={ui.error}>{errorMessage(plugins.error, strings.errors.loadFailed('plugins'))}</p>
      ) : (
        <AddDeviceForm drivers={drivers} />
      )}
    </>
  );
}
