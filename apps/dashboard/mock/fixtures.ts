import type { AuditEntry, Device, HotFolder, Job, JobError, JobStatus, JobStep, Page, Plugin } from '../src/api/types';

/**
 * Deterministic seed data for the mock API. Names and paths are generic examples; device and
 * plugin fixtures name no vendors or models (those belong in plugins/ and device profiles).
 */

export const FIXTURE_EPOCH = Date.parse('2026-01-15T08:00:00.000Z');
const MINUTE_MS = 60_000;
const JOB_SPACING_MINUTES = 7;
const STEP_DURATION_MS = 4_000;

const PT_PER_INCH = 72;
const PT_PER_MM = PT_PER_INCH / 25.4;
/** Bleed added around trimmed pages (≈ 3 mm). */
export const BLEED_PT = 8.5;

const mm = (value: number) => Math.round(value * PT_PER_MM * 100) / 100;
const inch = (value: number) => value * PT_PER_INCH;

export const A4_PT = { width: 595.28, height: 841.89 };
export const LETTER_PT = { width: 612, height: 792 };

export const HOT_FOLDER_IDS = { banners: 'hf-banners', posters: 'hf-posters', archive: 'hf-archive' } as const;
export const DEVICE_IDS = { rollA: 'dev-roll-a' } as const;
export const PLUGIN_IDS = { handoff: 'printer-handoff', mock: 'printer-mock', inspector: 'inspect-basic' } as const;

const iso = (ms: number) => new Date(ms).toISOString();

/** ULID-shaped (26 Crockford base32 characters) fixed ids. */
export function fixtureId(n: number): string {
  return `01JHZ8K${String(n).padStart(19, '0')}`;
}

/** Deterministic 64-hex-digit stand-in for a digest (FNV-1a chain; not a real SHA-256). */
export function fakeSha256(seed: string): string {
  let out = '';
  let hash = 0x811c9dc5;
  for (let round = 0; out.length < 64; round += 1) {
    for (const ch of `${seed}:${round}`) {
      hash ^= ch.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

type PageSize = Omit<Page, 'index'>;

/** A trimmed page with bleed on every side; the trim box is the finished size. */
export function withBleed(widthPt: number, heightPt: number): PageSize {
  return {
    widthPt: Math.round((widthPt + 2 * BLEED_PT) * 100) / 100,
    heightPt: Math.round((heightPt + 2 * BLEED_PT) * 100) / 100,
    trimBox: { x: BLEED_PT, y: BLEED_PT, width: widthPt, height: heightPt },
  };
}

export function plain(widthPt: number, heightPt: number): PageSize {
  return { widthPt, heightPt, trimBox: null };
}

export function indexPages(sizes: readonly PageSize[]): Page[] {
  return sizes.map((size, index) => ({ index, ...size }));
}

/** Page used for jobs that arrive while the mock runs. */
export const DEFAULT_INGEST_PAGE: PageSize = withBleed(mm(1000), mm(700));

export const HANDOFF_CONFIG_SCHEMA = {
  type: 'object',
  required: ['targetDir'],
  properties: {
    targetDir: {
      type: 'string',
      title: 'Target hot folder',
      description: 'Absolute path of the folder the external RIP watches.',
      pattern: '^(/|[A-Za-z]:[\\\\/]|\\\\\\\\)',
    },
    fileNamePattern: {
      type: 'string',
      title: 'File name pattern',
      description: 'Placeholders: {jobName}, {jobId}.',
      default: '{jobName}_{jobId}.pdf',
    },
    conflict: {
      type: 'string',
      title: 'If the file already exists',
      enum: ['suffix', 'overwrite', 'fail'],
      default: 'suffix',
    },
    writeTicketSidecar: { type: 'boolean', title: 'Write the job ticket next to the PDF ({base}.json)', default: false },
    verifyAfterCopy: { type: 'boolean', title: 'Verify size and SHA-256 after copying', default: true },
  },
} as const;

export function seedPlugins(): Plugin[] {
  return [
    {
      id: PLUGIN_IDS.handoff,
      name: 'Hot-folder handoff',
      version: '0.2.0',
      license: 'Apache-2.0',
      protocol: 'bpp/1',
      provides: [{ interface: 'PrinterDriver', versions: '>=1.1 <2' }],
      trust: 'builtin',
      state: 'running',
      capabilities: { accepts: ['document'], documentTypes: ['application/pdf'] },
      configSchema: structuredClone(HANDOFF_CONFIG_SCHEMA) as unknown as Record<string, unknown>,
    },
    {
      id: PLUGIN_IDS.mock,
      name: 'Mock printer',
      version: '0.1.0',
      license: 'Apache-2.0',
      protocol: 'bpp/1',
      provides: [{ interface: 'PrinterDriver', versions: '>=1.0 <2' }],
      trust: 'builtin',
      state: 'running',
      capabilities: { accepts: ['bands'] },
      configSchema: {
        type: 'object',
        properties: {
          bandHeightPx: { type: 'integer', title: 'Band height (px)', minimum: 16, maximum: 4096, default: 256 },
          failRate: { type: 'number', title: 'Simulated failure rate (0–1)', minimum: 0, maximum: 1, default: 0 },
        },
      },
    },
    {
      id: PLUGIN_IDS.inspector,
      name: 'Basic PDF inspector',
      version: '0.1.0',
      license: 'Apache-2.0',
      protocol: 'bpp/1',
      provides: [{ interface: 'Inspector', versions: '>=1.0 <2' }],
      trust: 'builtin',
      state: 'running',
      configSchema: null,
    },
  ];
}

export function seedHotFolders(): HotFolder[] {
  const created = iso(FIXTURE_EPOCH - 7 * 24 * 60 * MINUTE_MS);
  const settings = {
    moveProcessedTo: null,
    defaultPriority: 50,
    filePatterns: ['*.pdf'],
    dedupe: true,
    ticketTemplate: null,
    defaultDeviceId: null,
  };
  return [
    {
      id: HOT_FOLDER_IDS.banners,
      name: 'Banners',
      path: '/srv/print/hot/banners',
      enabled: true,
      settings: { ...settings, defaultPriority: 60, defaultDeviceId: DEVICE_IDS.rollA },
      createdAt: created,
      updatedAt: created,
    },
    {
      id: HOT_FOLDER_IDS.posters,
      name: 'Posters',
      path: '/srv/print/hot/posters',
      enabled: true,
      settings: { ...settings, filePatterns: ['*.pdf', '*.PDF'] },
      createdAt: created,
      updatedAt: created,
    },
    {
      id: HOT_FOLDER_IDS.archive,
      name: 'Archive reprints',
      path: '/srv/print/hot/archive',
      enabled: false,
      settings: { ...settings, defaultPriority: 20, dedupe: false, moveProcessedTo: '/srv/print/done/archive' },
      createdAt: created,
      updatedAt: created,
    },
  ];
}

export function seedDevices(): Device[] {
  const created = iso(FIXTURE_EPOCH - 6 * 24 * 60 * MINUTE_MS);
  return [
    {
      id: DEVICE_IDS.rollA,
      name: 'Roll printer A',
      kind: 'printer',
      pluginId: PLUGIN_IDS.handoff,
      config: {
        targetDir: '/srv/rip/in/roll-a',
        fileNamePattern: '{jobName}_{jobId}.pdf',
        conflict: 'suffix',
        writeTicketSidecar: false,
        verifyAfterCopy: true,
      },
      autoDispatch: false,
      maxConcurrency: 1,
      status: { state: 'ready', reason: null, checkedAt: iso(FIXTURE_EPOCH) },
      createdAt: created,
      updatedAt: created,
    },
  ];
}

interface JobSpec {
  name: string;
  status: JobStatus;
  priority: number;
  hotFolderId: string | null;
  pages: PageSize[];
  deviceId?: string;
  /** Failure, and the stage it happened in. */
  failure?: { stage: 'inspect' | 'output'; error: JobError };
  sizeBytes: number;
}

const ROLL = DEVICE_IDS.rollA;
const A4_TRIMMED = withBleed(A4_PT.width, A4_PT.height);

const JOB_SPECS: readonly JobSpec[] = [
  { name: 'rollup-850x2000-spring', status: 'done', priority: 50, hotFolderId: HOT_FOLDER_IDS.banners, pages: [withBleed(mm(850), mm(2000))], deviceId: ROLL, sizeBytes: 18_204_331 },
  { name: 'poster-24x36-event', status: 'printed', priority: 40, hotFolderId: HOT_FOLDER_IDS.posters, pages: [plain(inch(24), inch(36))], deviceId: ROLL, sizeBytes: 9_876_002 },
  { name: 'banner-3000x1000-sale', status: 'sent_to_device', priority: 60, hotFolderId: HOT_FOLDER_IDS.banners, pages: [withBleed(mm(3000), mm(1000))], deviceId: ROLL, sizeBytes: 31_440_918 },
  {
    name: 'window-graphic-left',
    status: 'failed',
    priority: 40,
    hotFolderId: HOT_FOLDER_IDS.banners,
    pages: [],
    failure: { stage: 'inspect', error: { code: 'PDF_UNREADABLE', message: 'The PDF could not be parsed.', detail: 'Unexpected end of file at byte 18432.' } },
    sizeBytes: 18_432,
  },
  {
    name: 'trade-show-backwall',
    status: 'failed',
    priority: 70,
    hotFolderId: HOT_FOLDER_IDS.banners,
    pages: [withBleed(mm(2400), mm(2250))],
    deviceId: ROLL,
    failure: { stage: 'output', error: { code: 'DELIVERY_FAILED', message: 'The target folder is not writable.', detail: 'Permission denied after 3 attempts.' } },
    sizeBytes: 44_100_276,
  },
  { name: 'floor-decal-round-600', status: 'cancelled', priority: 30, hotFolderId: HOT_FOLDER_IDS.posters, pages: [withBleed(mm(600), mm(600))], sizeBytes: 2_310_455 },
  { name: 'brochure-a4-3pages', status: 'ready', priority: 50, hotFolderId: HOT_FOLDER_IDS.posters, pages: [A4_TRIMMED, A4_TRIMMED, A4_TRIMMED], sizeBytes: 4_512_090 },
  { name: 'menu-board-letter', status: 'ready', priority: 45, hotFolderId: null, pages: [plain(LETTER_PT.width, LETTER_PT.height)], sizeBytes: 812_774 },
  { name: 'canvas-print-400x600', status: 'ready', priority: 30, hotFolderId: HOT_FOLDER_IDS.posters, pages: [withBleed(mm(400), mm(600))], sizeBytes: 6_002_183 },
  { name: 'vehicle-wrap-panel-2', status: 'held', priority: 55, hotFolderId: HOT_FOLDER_IDS.banners, pages: [withBleed(mm(1370), mm(2500))], sizeBytes: 52_778_301 },
  { name: 'mesh-banner-fence', status: 'queued', priority: 80, hotFolderId: HOT_FOLDER_IDS.banners, pages: [withBleed(mm(5000), mm(1000))], deviceId: ROLL, sizeBytes: 27_650_118 },
  { name: 'wall-mural-section-a', status: 'queued', priority: 50, hotFolderId: HOT_FOLDER_IDS.posters, pages: [withBleed(mm(1200), mm(2600))], sizeBytes: 38_090_552 },
  { name: 'flyer-a5-batch', status: 'inspecting', priority: 50, hotFolderId: HOT_FOLDER_IDS.posters, pages: [], sizeBytes: 1_204_998 },
  { name: 'sticker-sheet-sra3', status: 'received', priority: 50, hotFolderId: HOT_FOLDER_IDS.posters, pages: [], sizeBytes: 3_330_871 },
];

const PAST_INSPECT: readonly JobStatus[] = ['ready', 'held', 'queued', 'processing', 'sent_to_device', 'printed', 'done', 'cancelled'];
const DELIVERED: readonly JobStatus[] = ['sent_to_device', 'printed', 'done'];

function step(jobId: string, stage: string, status: JobStep['status'], startMs: number, extra: Partial<JobStep> = {}): JobStep {
  const finished = status === 'completed' || status === 'failed';
  return {
    id: `${jobId}-${stage}-1`,
    stage,
    status,
    pluginId: stage === 'inspect' ? PLUGIN_IDS.inspector : null,
    startedAt: iso(startMs),
    finishedAt: finished ? iso(startMs + STEP_DURATION_MS) : null,
    error: null,
    result: null,
    ...extra,
  };
}

function buildJob(spec: JobSpec, n: number): Job {
  const id = fixtureId(n);
  const createdMs = FIXTURE_EPOCH + n * JOB_SPACING_MINUTES * MINUTE_MS;
  const sha256 = fakeSha256(id);
  const steps: JobStep[] = [step(id, 'intake', 'completed', createdMs)];
  const audit: AuditEntry[] = [
    { id: `${id}-a1`, time: iso(createdMs), type: 'job.created', message: 'Job created from the hot folder.', data: null },
  ];
  const inspectStart = createdMs + STEP_DURATION_MS;
  const outputStart = inspectStart + 2 * STEP_DURATION_MS;

  if (spec.status === 'inspecting') steps.push(step(id, 'inspect', 'running', inspectStart));
  if (PAST_INSPECT.includes(spec.status) || spec.failure?.stage === 'output') {
    steps.push(step(id, 'inspect', 'completed', inspectStart));
  }
  if (spec.failure?.stage === 'inspect') {
    steps.push(step(id, 'inspect', 'failed', inspectStart, { error: spec.failure.error }));
  }
  if (spec.failure?.stage === 'output') {
    steps.push(step(id, 'output', 'failed', outputStart, { pluginId: PLUGIN_IDS.handoff, error: spec.failure.error }));
  }
  if (DELIVERED.includes(spec.status)) {
    const deliveredPath = `/srv/rip/in/roll-a/${spec.name}_${id}.pdf`;
    const result = { deliveredPath, bytes: spec.sizeBytes, sha256, time: iso(outputStart + STEP_DURATION_MS) };
    steps.push(step(id, 'output', 'completed', outputStart, { pluginId: PLUGIN_IDS.handoff, result }));
    audit.push({ id: `${id}-a2`, time: result.time, type: 'delivery', message: `Delivered to ${deliveredPath}.`, data: { deviceId: ROLL, ...result } });
  }
  const updatedMs = createdMs + steps.length * STEP_DURATION_MS;
  if (spec.status !== 'received') {
    audit.push({ id: `${id}-a3`, time: iso(updatedMs), type: 'status.changed', message: `Status changed to ${spec.status}.`, data: { to: spec.status } });
  }

  return {
    id,
    name: spec.name,
    sourcePath: spec.hotFolderId ? `${seedHotFolders().find((f) => f.id === spec.hotFolderId)?.path}/${spec.name}.pdf` : null,
    storedPath: `spool/${id}.pdf`,
    sizeBytes: spec.sizeBytes,
    sha256,
    pageCount: spec.pages.length,
    pages: indexPages(spec.pages),
    status: spec.status,
    priority: spec.priority,
    hotFolderId: spec.hotFolderId,
    ticketId: null,
    deviceId: spec.deviceId ?? null,
    steps,
    audit,
    createdAt: iso(createdMs),
    updatedAt: iso(updatedMs),
    error: spec.failure?.error ?? null,
  };
}

export function seedJobs(): Job[] {
  return JOB_SPECS.map((spec, i) => buildJob(spec, i + 1));
}
