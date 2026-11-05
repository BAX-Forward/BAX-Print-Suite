/**
 * Test harness: spawns the color-sim plugin as a child process and drives it over BPP using the
 * SDK's Connection (which owns the Content-Length framing). No transport code lives here.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  BPP_PROTOCOL,
  Connection,
  type InitializeParams,
  type MeasurementLayout,
} from '@bax-print/plugin-sdk';

/** Mirrors `ColorSimMethods` in plugins/color-sim/src/main.ts (not imported: importing starts the server). */
export const ColorSimMethods = Object.freeze({
  listInstruments: 'measurement/listInstruments',
  measureStrip: 'measurement/measureStrip',
  printChart: 'colorSim/printChart',
});

/** BPP lifecycle methods handled by PluginServer. */
export const LifecycleMethods = Object.freeze({
  initialize: 'initialize',
  configure: 'configure',
  shutdown: 'shutdown',
  exit: 'exit',
});

const PLUGIN_ENTRY = fileURLToPath(new URL('../../../plugins/color-sim/src/main.ts', import.meta.url));
/** packages/media, where `tsx` resolves as a devDependency. */
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const REQUEST_TIMEOUT_MS = 10_000;

const INITIALIZE_PARAMS: InitializeParams = {
  protocol: BPP_PROTOCOL,
  host: { name: 'color-sim-harness', version: '0.0.0' },
  interfaces: [{ interface: 'Measurement', versions: '>=1.0 <2' }],
  spoolDir: tmpdir(),
  capabilities: { transports: ['file'] },
};
const EXIT_TIMEOUT_MS = 5_000;

export interface Cmyk {
  c: number;
  m: number;
  y: number;
  k: number;
}

export interface PrintedPatch {
  patchId: string;
  cmyk: Cmyk;
}

export interface ColorSimSettings {
  seed: number;
  sigmaDe?: number;
}

export interface MeasureOptions {
  instrumentId?: string;
}

export interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class ColorSimHarness {
  private readonly exited: Promise<ExitResult>;
  private stderr = '';

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: Connection,
  ) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  }

  static async start(): Promise<ColorSimHarness> {
    const child = spawn(process.execPath, ['--import', 'tsx', PLUGIN_ENTRY], {
      cwd: PACKAGE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const connection = new Connection(child.stdout, child.stdin);
    const harness = new ColorSimHarness(child, connection);
    try {
      await harness.call(LifecycleMethods.initialize, INITIALIZE_PARAMS);
    } catch (error) {
      child.kill();
      throw harness.withStderr(error);
    }
    return harness;
  }

  /** Starts a fresh simulator with a fixed seed; drops any printed charts. */
  configure(settings: ColorSimSettings): Promise<void> {
    return this.call(LifecycleMethods.configure, { settings }).then(() => undefined);
  }

  listInstruments<R = unknown>(): Promise<R> {
    return this.call<R>(ColorSimMethods.listInstruments, {});
  }

  printChart(chartId: string, patches: readonly PrintedPatch[]): Promise<void> {
    return this.call(ColorSimMethods.printChart, { chartId, patches }).then(() => undefined);
  }

  measureStrip<R = unknown>(layout: MeasurementLayout, options: MeasureOptions = {}): Promise<R> {
    return this.call<R>(ColorSimMethods.measureStrip, { layout, options });
  }

  /** Shuts the plugin down and resolves with its exit status; kills it if it does not exit in time. */
  async close(): Promise<ExitResult> {
    if (!this.connection.isClosed) {
      try {
        await this.call(LifecycleMethods.shutdown, {});
      } finally {
        this.connection.notify(LifecycleMethods.exit);
        this.connection.close();
        this.child.stdin.end();
      }
    }
    const timer = setTimeout(() => this.child.kill(), EXIT_TIMEOUT_MS);
    try {
      return await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  private async call<R = unknown>(method: string, params: unknown): Promise<R> {
    return this.connection.request<R>(method, params, { timeoutMs: REQUEST_TIMEOUT_MS });
  }

  private withStderr(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`color-sim failed to start: ${message}\n${this.stderr}`);
  }
}
