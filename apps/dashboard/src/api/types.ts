import type { components } from './schema';

type Schemas = components['schemas'];

/** A job as GET /jobs and GET /jobs/:id answer it (Spec 052a). */
export type Job = Schemas['Job'];
export type JobSourceFile = Job['sourceFiles'][number];
/** Mock-only control-plane record (PATCH, print, job events); not served by the 052a server. */
export type JobRecord = Schemas['JobRecord'];
export type JobStatus = Schemas['JobStatus'];
export type JobPage = Schemas['JobPage'];
export type JobEnvelope = Schemas['JobEnvelope'];
export type JobPatch = Schemas['JobPatch'];
export type JobStep = Schemas['JobStep'];
export type JobError = Schemas['JobError'];
export type StepStatus = Schemas['StepStatus'];
export type AuditEntry = Schemas['AuditEntry'];
export type Page = Schemas['Page'];
export type Box = Schemas['Box'];
export type Transitions = Schemas['Transitions'];
export type HotFolder = Schemas['HotFolder'];
export type HotFolderCreate = Schemas['HotFolderCreate'];
export type HotFolderPatch = Schemas['HotFolderPatch'];
export type HotFolderSettingsInput = Schemas['HotFolderSettingsInput'];
export type Plugin = Schemas['Plugin'];
export type Device = Schemas['Device'];
export type DeviceCreate = Schemas['DeviceCreate'];
export type DevicePatch = Schemas['DevicePatch'];
export type DeviceState = Schemas['DeviceStatus']['state'];
export type Problem = Schemas['Problem'];
export type Health = Schemas['Health'];
export type CloudEvent = Schemas['CloudEvent'];

/** Display order of the statuses. Mirrors the JobStatus enum in mock/openapi.json (checked by a contract test). */
export const JOB_STATUSES: readonly JobStatus[] = [
  'received',
  'inspecting',
  'ready',
  'held',
  'queued',
  'processing',
  'sent_to_device',
  'printed',
  'done',
  'failed',
  'cancelled',
];

/** The 052a Job carries its status as a plain string; this narrows it to a status the UI knows. */
export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

/** Interface name a plugin must provide to be offered as a printer driver. */
export const PRINTER_DRIVER_INTERFACE = 'PrinterDriver';

export function isPrinterDriver(plugin: Plugin): boolean {
  return plugin.provides.some((p) => p.interface === PRINTER_DRIVER_INTERFACE);
}
