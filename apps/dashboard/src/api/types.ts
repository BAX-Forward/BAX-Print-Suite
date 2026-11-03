import type { components } from './schema';

type Schemas = components['schemas'];

export type Job = Schemas['Job'];
export type JobStatus = Schemas['JobStatus'];
export type JobSort = Schemas['JobSort'];
export type JobPage = Schemas['JobPage'];
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

export type SortField = 'createdAt' | 'priority' | 'name';

/** Display order for filters. Mirrors the JobStatus enum in /openapi.json (checked by a contract test). */
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

export const JOB_SORTS: readonly JobSort[] = [
  'createdAt',
  '-createdAt',
  'priority',
  '-priority',
  'name',
  '-name',
];

/** Interface name a plugin must provide to be offered as a printer driver. */
export const PRINTER_DRIVER_INTERFACE = 'PrinterDriver';

export function isPrinterDriver(plugin: Plugin): boolean {
  return plugin.provides.some((p) => p.interface === PRINTER_DRIVER_INTERFACE);
}
