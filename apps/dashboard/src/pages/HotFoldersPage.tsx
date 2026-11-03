import { useId, useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { ApiError, errorMessage } from '../api/client';
import { useCreateHotFolder, useDeleteHotFolder, useDevices, useHotFolders, usePatchHotFolder } from '../api/queries';
import type { HotFolder, HotFolderCreate } from '../api/types';
import { useToast } from '../components/Toasts';
import ui from '../components/ui.module.css';
import { strings } from '../strings';

const t = strings.hotFolders;

interface FolderForm {
  path: string;
  name: string;
  patterns: string;
  priority: string;
  dedupe: boolean;
  processed: string;
  deviceId: string;
}

type FormKey = keyof FolderForm;

const EMPTY_FORM: FolderForm = {
  path: '',
  name: '',
  patterns: '*.pdf',
  priority: '50',
  dedupe: true,
  processed: '',
  deviceId: '',
};

/** Server field paths (Problem.errors[].field) → the form control that shows the message. */
const FIELD_FOR_ERROR: Record<string, FormKey> = {
  path: 'path',
  name: 'name',
  'settings.filePatterns': 'patterns',
  'settings.defaultPriority': 'priority',
  'settings.dedupe': 'dedupe',
  'settings.moveProcessedTo': 'processed',
  'settings.defaultDeviceId': 'deviceId',
};

export function toHotFolderCreate(form: FolderForm): HotFolderCreate {
  const patterns = form.patterns
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  return {
    path: form.path.trim(),
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    settings: {
      // Sent as typed; the server validates and its messages are shown inline.
      filePatterns: patterns,
      ...(form.priority.trim() === '' ? {} : { defaultPriority: Number(form.priority) }),
      dedupe: form.dedupe,
      moveProcessedTo: form.processed.trim() || null,
      defaultDeviceId: form.deviceId || null,
    },
  };
}

function formErrors(error: unknown): Partial<Record<FormKey, string>> {
  if (!(error instanceof ApiError)) return {};
  const out: Partial<Record<FormKey, string>> = {};
  for (const [field, message] of Object.entries(error.fieldErrors)) {
    const key = FIELD_FOR_ERROR[field];
    if (key && !out[key]) out[key] = message;
  }
  return out;
}

interface A11yProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

function Field({
  id,
  label,
  hint,
  error,
  required,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (props: A11yProps) => ReactElement;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={ui.field}>
      <label htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && (
        <p id={hintId} className={ui.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={ui.error}>
          {error}
        </p>
      )}
    </div>
  );
}

function AddHotFolderForm() {
  const toast = useToast();
  const devices = useDevices();
  const create = useCreateHotFolder();
  const [form, setForm] = useState<FolderForm>(EMPTY_FORM);
  const idPrefix = useId();
  const fid = (key: FormKey) => `${idPrefix}-${key}`;
  const errors = formErrors(create.error);
  const f = t.fields;

  const set = <K extends FormKey>(key: K, value: FolderForm[K]) => setForm((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(toHotFolderCreate(form), {
      onSuccess: (folder) => {
        toast.success(t.added(folder.name));
        setForm(EMPTY_FORM);
        create.reset();
      },
    });
  };

  return (
    <section aria-labelledby="hotfolder-add-heading">
      <h2 id="hotfolder-add-heading">{t.addHeading}</h2>
      {/* Validation happens on the server (path rules depend on its file system); errors appear inline. */}
      <form className={ui.form} onSubmit={submit} noValidate>
        {create.isError && (
          <p className={ui.error} role="alert">
            {errorMessage(create.error, strings.errors.unknown)}
          </p>
        )}
        <Field id={fid('path')} label={f.path} hint={f.pathHint} error={errors.path} required>
          {(props) => (
            <input
              {...props}
              type="text"
              aria-required="true"
              autoComplete="off"
              spellCheck={false}
              value={form.path}
              onChange={(event) => set('path', event.target.value)}
            />
          )}
        </Field>
        <Field id={fid('name')} label={f.name} hint={f.nameHint} error={errors.name}>
          {(props) => <input {...props} type="text" value={form.name} onChange={(event) => set('name', event.target.value)} />}
        </Field>
        <Field id={fid('patterns')} label={f.patterns} hint={f.patternsHint} error={errors.patterns}>
          {(props) => (
            <input {...props} type="text" value={form.patterns} onChange={(event) => set('patterns', event.target.value)} />
          )}
        </Field>
        <Field id={fid('priority')} label={f.priority} error={errors.priority}>
          {(props) => (
            <input
              {...props}
              type="number"
              min={0}
              max={100}
              step={1}
              value={form.priority}
              onChange={(event) => set('priority', event.target.value)}
              style={{ width: '6em' }}
            />
          )}
        </Field>
        <div className={ui.checkboxField}>
          <input
            id={fid('dedupe')}
            type="checkbox"
            checked={form.dedupe}
            aria-invalid={errors.dedupe ? true : undefined}
            onChange={(event) => set('dedupe', event.target.checked)}
          />
          <label htmlFor={fid('dedupe')}>{f.dedupe}</label>
          {errors.dedupe && <p className={ui.error}>{errors.dedupe}</p>}
        </div>
        <Field id={fid('processed')} label={f.processed} hint={f.processedHint} error={errors.processed}>
          {(props) => (
            <input
              {...props}
              type="text"
              spellCheck={false}
              value={form.processed}
              onChange={(event) => set('processed', event.target.value)}
            />
          )}
        </Field>
        <Field id={fid('deviceId')} label={f.device} error={errors.deviceId}>
          {(props) => (
            <select {...props} value={form.deviceId} onChange={(event) => set('deviceId', event.target.value)}>
              <option value="">{f.noDevice}</option>
              {(devices.data ?? []).map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div>
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? strings.common.loading : t.add}
          </button>
        </div>
      </form>
    </section>
  );
}

function HotFolderRow({ folder, deviceNames }: { folder: HotFolder; deviceNames: Map<string, string> }) {
  const toast = useToast();
  const patch = usePatchHotFolder();
  const remove = useDeleteHotFolder();
  const [confirming, setConfirming] = useState(false);
  const busy = patch.isPending || remove.isPending;
  const { settings } = folder;
  const deviceId = settings.defaultDeviceId;

  return (
    <tr data-hotfolder-id={folder.id}>
      <th scope="row">{folder.name}</th>
      <td>
        <code>{folder.path}</code>
      </td>
      <td>{settings.filePatterns.join(', ')}</td>
      <td>{settings.defaultPriority}</td>
      <td>{settings.dedupe ? strings.common.yes : strings.common.no}</td>
      <td>{settings.moveProcessedTo ? <code>{settings.moveProcessedTo}</code> : t.defaultProcessed}</td>
      <td>{deviceId ? (deviceNames.get(deviceId) ?? deviceId) : strings.common.none}</td>
      <td>
        <span className={ui.badge} data-tone={folder.enabled ? 'success' : 'neutral'}>
          {folder.enabled ? t.enabled : t.disabled}
        </span>
      </td>
      <td>
        <div className={ui.inlineGroup}>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            aria-label={folder.enabled ? t.disable(folder.name) : t.enable(folder.name)}
            onClick={() => patch.mutate({ id: folder.id, patch: { enabled: !folder.enabled } })}
          >
            {folder.enabled ? t.disableShort : t.enableShort}
          </button>
          {confirming ? (
            <>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() =>
                  remove.mutate(folder.id, {
                    onSuccess: () => toast.success(t.removed(folder.name)),
                    onSettled: () => setConfirming(false),
                  })
                }
              >
                {t.confirmRemove}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                {t.keep}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              aria-label={t.removeLabel(folder.name)}
              onClick={() => setConfirming(true)}
            >
              {t.remove}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

export function HotFoldersPage() {
  const hotFolders = useHotFolders();
  const devices = useDevices();
  const deviceNames = useMemo(
    () => new Map((devices.data ?? []).map((device) => [device.id, device.name])),
    [devices.data],
  );
  const c = t.columns;

  return (
    <>
      <h1>{t.title}</h1>
      <p className={ui.hint}>{t.removeNote}</p>
      {hotFolders.isPending ? (
        <p>{strings.common.loading}</p>
      ) : hotFolders.isError ? (
        <p className={ui.error}>{errorMessage(hotFolders.error, strings.errors.loadFailed('hot folders'))}</p>
      ) : hotFolders.data.length === 0 ? (
        <p className={ui.muted}>{t.empty}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className={ui.table}>
            <caption className="visually-hidden">{t.caption}</caption>
            <thead>
              <tr>
                {[c.name, c.path, c.patterns, c.priority, c.dedupe, c.processed, c.device, c.state, c.actions].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {hotFolders.data.map((folder) => (
                <HotFolderRow key={folder.id} folder={folder} deviceNames={deviceNames} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AddHotFolderForm />
    </>
  );
}
