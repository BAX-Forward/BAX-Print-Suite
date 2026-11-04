import type { OutputModeReport, PrinterDriverMediaApi } from '@bax-print/plugin-sdk';
import { type MediaRepository, openMediaStore } from '@bax-print/store';
import { MediaLibrary, type MediaEvent, type ProfileInput } from '../src/index.js';

/** Deterministic ids and clock, so tests can compare records byte for byte. */
export function testContext(repo: MediaRepository = openMediaStore(':memory:'), prefix = 'id') {
  let id = 0;
  let tick = 0;
  const events: MediaEvent[] = [];
  return {
    repo,
    events,
    newId: () => `${prefix}-${String(++id).padStart(5, '0')}`,
    now: () => new Date(Date.UTC(2026, 10, 2) + 1000 * tick++).toISOString(),
    emit: (event: MediaEvent) => {
      events.push(event);
    },
  };
}

export function testLibrary(repo?: MediaRepository, prefix?: string) {
  const ctx = testContext(repo, prefix);
  return { library: new MediaLibrary(ctx), ...ctx };
}

/** A structurally valid ICC.1 header (size, `acsp` signature) followed by `seed` bytes. */
export function fakeIcc(seed: number, size = 256): Uint8Array {
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, size);
  bytes.set([0x61, 0x63, 0x73, 0x70], 36);
  bytes.fill(seed & 0xff, 128);
  return bytes;
}

export function profileInput(redistributable: boolean, colorants = ['cyan', 'magenta', 'yellow', 'black']): ProfileInput {
  return {
    description: redistributable ? 'Shop profile' : 'Licensed profile',
    format: 'icc',
    colorants,
    provenance: redistributable
      ? { source: 'measured in house', license: 'CC0-1.0', redistributable: true }
      : { source: 'downloaded by the user', license: 'end-user license', redistributable: false },
  };
}

export function modeReport(modeKey: string, extra: Partial<OutputModeReport> = {}): OutputModeReport {
  return {
    modeKey,
    name: `Mode ${modeKey}`,
    resolutionDpi: { x: 1200, y: 1200 },
    passes: 8,
    inkSet: ['cyan', 'magenta', 'yellow', 'black'],
    direction: 'bidirectional',
    params: { opaque: modeKey },
    ...extra,
  };
}

/** A generic driver fixture: one medium, a configurable mode list. */
export function fixtureDriver(modes: () => OutputModeReport[]): PrinterDriverMediaApi {
  return {
    listMedia: async () => [{ mediumKey: 'film-1', name: 'Generic film', kind: 'film', widthsMm: [1370], form: 'roll', sides: 1 }],
    listModes: async () => modes(),
  };
}
