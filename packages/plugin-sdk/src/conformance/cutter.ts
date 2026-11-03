// CutterDriver/2 conformance kit (spec 004, acceptance 7 and 8). The report is
// the definition of compliance (ARCHITECTURE §3.6); test frameworks only assert
// that `passed` is true.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCutterDriverClient } from "../cutter-bpp.js";
import {
  CORNERS,
  CUTTER_DRIVER_INTERFACE,
  CUTTER_DRIVER_VERSION,
  CutterDriverError,
  sha256Hex,
  type CutFormat,
  type CutJob,
  type CutterDriver,
  type CutterProfile,
  type DeviceConfig,
  type Point,
  type Range,
} from "../cutter.js";
import { launchPlugin, RpcError, RpcErrorCode, satisfiesRange } from "../stub.js";

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ConformanceReport {
  passed: boolean;
  checks: ConformanceCheck[];
}

export interface CutterConformanceOptions {
  deviceConfig?: DeviceConfig;
  /** Overrides the generated sample job (it must be valid for the plugin's profile). */
  sampleJob?: CutJob;
}

const MACHINE_CLASSES = ["roll", "flatbed"];
const DEVICE_STATES = ["ready", "busy", "offline", "unknown"];
const CUTTING_KINDS = ["drag-knife", "tangential-knife", "kiss", "thru"];
const PT_PER_MM = 72 / 25.4;
const UNKNOWN_FORMAT = "bps-conformance-unknown-format";

function checkRange(range: Range | undefined, where: string): string[] {
  if (range === undefined) return [];
  const problems: string[] = [];
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) problems.push(`${where}: min/max must be finite numbers`);
  else if (range.min > range.max) problems.push(`${where}: min > max`);
  if (typeof range.unit !== "string" || range.unit.length === 0) problems.push(`${where}: unit is required`);
  if (range.step !== undefined && !(range.step > 0)) problems.push(`${where}: step must be > 0`);
  return problems;
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v.length > 0);
}

/** Structural checks of a CutterProfile. Returns a list of problems (empty = valid). */
export function checkCutterProfile(profile: CutterProfile): string[] {
  const problems: string[] = [];
  if (!MACHINE_CLASSES.includes(profile.class)) problems.push(`class must be one of ${MACHINE_CLASSES.join(", ")}`);
  if (!(profile.workArea?.widthMm > 0)) problems.push("workArea.widthMm must be > 0");
  if (profile.workArea?.lengthMm !== undefined && !(profile.workArea.lengthMm > 0)) problems.push("workArea.lengthMm must be > 0 when set");
  if (profile.class === "roll") {
    if (!profile.roll) problems.push("roll machines must declare `roll`");
    else {
      if (typeof profile.roll.supportsPanelAdvance !== "boolean") problems.push("roll.supportsPanelAdvance must be a boolean");
      if (!CORNERS.includes(profile.roll.loadOrigin)) problems.push("roll.loadOrigin must be a corner");
      if (profile.roll.maxPanelLengthMm !== undefined && !(profile.roll.maxPanelLengthMm > 0)) problems.push("roll.maxPanelLengthMm must be > 0");
    }
  }
  if (profile.class === "flatbed") {
    if (!profile.flatbed) problems.push("flatbed machines must declare `flatbed`");
    else if (!CORNERS.includes(profile.flatbed.bedOrigin)) problems.push("flatbed.bedOrigin must be a corner");
    if (profile.workArea?.lengthMm === undefined) problems.push("flatbed machines must declare workArea.lengthMm");
  }
  if (!Array.isArray(profile.tools) || profile.tools.length === 0) problems.push("tools must be a non-empty array");
  else {
    const ids = new Set<string>();
    for (const tool of profile.tools) {
      if (typeof tool.id !== "string" || tool.id.length === 0) problems.push("tool.id is required");
      else if (ids.has(tool.id)) problems.push(`duplicate tool id ${tool.id}`);
      ids.add(tool.id);
      if (typeof tool.kind !== "string" || tool.kind.length === 0) problems.push(`tool ${tool.id}: kind is required`);
      if (typeof tool.params !== "object" || tool.params === null) problems.push(`tool ${tool.id}: params must be an object`);
      else for (const [name, range] of Object.entries(tool.params)) problems.push(...checkRange(range, `tool ${tool.id}.params.${name}`));
    }
  }
  if (profile.toolSlots !== undefined && !(Number.isInteger(profile.toolSlots) && profile.toolSlots > 0)) problems.push("toolSlots must be a positive integer");
  if (!nonEmptyStringArray(profile.registration?.methods)) problems.push("registration.methods must be a non-empty string array");
  problems.push(...checkRange(profile.registration?.markSizeMm, "registration.markSizeMm"));
  if (!nonEmptyStringArray(profile.delivery)) problems.push("delivery must be a non-empty string array");
  if (!nonEmptyStringArray(profile.formats)) problems.push("formats must be a non-empty string array");
  return problems;
}

function squarePt(xMm: number, yMm: number, sideMm: number): Point[] {
  const [x, y, s] = [xMm * PT_PER_MM, yMm * PT_PER_MM, sideMm * PT_PER_MM];
  return [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
  ];
}

/** A 20 mm kiss-cut square in a 40 mm frame, mapped to the profile's first cutting tool. */
export function sampleCutJob(profile: CutterProfile): CutJob {
  const tool = profile.tools.find((t) => CUTTING_KINDS.includes(t.kind)) ?? profile.tools[0];
  const frameMm = 40;
  const points = squarePt(10, 10, 20);
  const s = 20 * PT_PER_MM;
  const registration = profile.registration.methods.includes("none")
    ? undefined
    : (() => {
        const dPt = (profile.registration.markSizeMm?.min ?? 5) * PT_PER_MM;
        const inset = 3 * PT_PER_MM;
        const far = frameMm * PT_PER_MM - inset;
        return {
          method: profile.registration.methods[0],
          shape: profile.registration.markShapes?.[0],
          originMarkId: "m0",
          marks: [
            { id: "m0", xPt: inset, yPt: inset, dPt },
            { id: "m1", xPt: far, yPt: inset, dPt },
            { id: "m2", xPt: inset, yPt: far, dPt },
            { id: "m3", xPt: far, yPt: far, dPt },
          ],
        };
      })();
  return {
    jobId: "conformance-0001",
    contours: [
      {
        id: "c1",
        tool: "kiss",
        source: { kind: "spot", name: "CutContour" },
        closed: true,
        points,
        bbox: { minX: points[0][0], minY: points[0][1], maxX: points[2][0], maxY: points[2][1] },
        areaSigned: s * s,
      },
    ],
    toolMap: { kiss: { toolId: tool.id } },
    frame: { widthPt: frameMm * PT_PER_MM, heightPt: frameMm * PT_PER_MM },
    ...(registration ? { marks: registration } : {}),
    options: {},
  };
}

class Recorder {
  readonly checks: ConformanceCheck[] = [];

  async run(name: string, fn: () => Promise<string | undefined | void> | string | undefined | void): Promise<void> {
    try {
      const failure = await fn();
      this.checks.push(failure ? { name, ok: false, detail: failure } : { name, ok: true });
    } catch (error) {
      this.checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  report(): ConformanceReport {
    return { passed: this.checks.every((c) => c.ok), checks: this.checks };
  }
}

async function runDriverChecks(driver: CutterDriver, options: CutterConformanceOptions, recorder: Recorder, expectFileHandles: boolean): Promise<void> {
  const deviceConfig = options.deviceConfig ?? {};
  // Assigned inside the check below; the cast keeps control-flow narrowing from treating it as always undefined.
  let profile = undefined as CutterProfile | undefined;
  await recorder.run("describe returns a valid CutterProfile", async () => {
    const described = await driver.describe(deviceConfig);
    const problems = checkCutterProfile(described);
    if (problems.length > 0) return problems.join("; ");
    // Later checks build a sample job from the profile, so they only run on a valid one.
    profile = described;
    return undefined;
  });
  if (!profile) return;
  const validProfile = profile;

  let formats: CutFormat[] = [];
  await recorder.run("formats are well-formed", async () => {
    formats = await driver.formats();
    if (!Array.isArray(formats) || formats.length === 0) return "formats() must return a non-empty array";
    const ids = formats.map((f) => f.id);
    if (new Set(ids).size !== ids.length) return "format ids must be unique";
    for (const f of formats) {
      if (!f.id || !f.mime?.includes("/")) return `format ${f.id}: id and a MIME type are required`;
      if (!f.ext || f.ext.startsWith(".")) return `format ${f.id}: ext is required, without a leading dot`;
      if (typeof f.optionsSchema !== "object" || f.optionsSchema === null) return `format ${f.id}: optionsSchema must be an object`;
    }
    return undefined;
  });
  await recorder.run("formats() matches profile.formats", () => {
    const listed = [...formats.map((f) => f.id)].sort();
    const declared = [...validProfile.formats].sort();
    return JSON.stringify(listed) === JSON.stringify(declared) ? undefined : `formats() ${listed.join(",")} vs profile ${declared.join(",")}`;
  });

  const job = options.sampleJob ?? sampleCutJob(validProfile);
  for (const format of formats) {
    let firstSha: string | undefined;
    await recorder.run(`export "${format.id}" returns a hashed artifact`, async () => {
      const result = await driver.export(job, format.id);
      if (!(result.bytes instanceof Uint8Array) || result.bytes.length === 0) return "bytes must be a non-empty Uint8Array";
      const actual = sha256Hex(result.bytes);
      if (actual !== result.sha256) return `sha256 mismatch: returned ${result.sha256}, actual ${actual}`;
      if (!Array.isArray(result.warnings) || !result.warnings.every((w) => typeof w === "string")) return "warnings must be a string array";
      if (!result.fileName.endsWith(`.${format.ext}`)) return `fileName ${result.fileName} must end with .${format.ext}`;
      if (result.mime !== format.mime) return `mime ${result.mime} differs from format mime ${format.mime}`;
      if (expectFileHandles) {
        if (result.handle.kind !== "file") return "with a spool directory configured, the handle must be a file";
        const onDisk = sha256Hex(new Uint8Array(await readFile(result.handle.path)));
        if (onDisk !== result.sha256) return "spooled artifact sha256 differs from the returned value";
      }
      firstSha = result.sha256;
      return undefined;
    });
    await recorder.run(`export "${format.id}" is deterministic`, async () => {
      const again = await driver.export(job, format.id);
      return firstSha === again.sha256 ? undefined : "two exports of the same job differ";
    });
  }

  await recorder.run("unknown format is rejected with code \"unsupported\"", async () => {
    try {
      await driver.export(job, UNKNOWN_FORMAT);
    } catch (error) {
      if (error instanceof CutterDriverError && error.code === "unsupported") return undefined;
      return `expected CutterDriverError("unsupported"), got ${error instanceof Error ? error.message : String(error)}`;
    }
    return "export of an unknown format succeeded";
  });

  if (driver.getStatus) {
    const getStatus = driver.getStatus.bind(driver);
    await recorder.run("getStatus returns a known state", async () => {
      try {
        const status = await getStatus(deviceConfig);
        return DEVICE_STATES.includes(status.state) ? undefined : `unknown state ${String(status.state)}`;
      } catch (error) {
        // Over BPP the client always exposes getStatus; a plugin that doesn't implement it is fine.
        if (error instanceof RpcError && error.code === RpcErrorCode.MethodNotFound) return undefined;
        throw error;
      }
    });
  }
}

/** Runs the kit against an in-process driver. */
export async function runCutterDriverConformance(driver: CutterDriver, options: CutterConformanceOptions = {}): Promise<ConformanceReport> {
  const recorder = new Recorder();
  await runDriverChecks(driver, options, recorder, false);
  return recorder.report();
}

/** Runs the kit against a plugin launched as a separate process from its manifest. */
export async function runCutterDriverConformanceProcess(
  manifestPath: string,
  options: CutterConformanceOptions & { initializeTimeoutMs?: number } = {},
): Promise<ConformanceReport> {
  const recorder = new Recorder();
  const spoolDir = await mkdtemp(join(tmpdir(), "bps-cutter-conformance-"));
  const stderr: string[] = [];
  try {
    const launched = await launchPlugin(manifestPath, {
      initializeTimeoutMs: options.initializeTimeoutMs ?? 15_000,
      onStderrLine: (line) => stderr.push(line),
    });
    try {
      await recorder.run("manifest provides CutterDriver/2", () => {
        const ok = launched.manifest.provides.some(
          (p) => p.interface === CUTTER_DRIVER_INTERFACE && satisfiesRange(CUTTER_DRIVER_VERSION, p.versions),
        );
        return ok ? undefined : `no provides entry for ${CUTTER_DRIVER_INTERFACE} ${CUTTER_DRIVER_VERSION}`;
      });
      await recorder.run("initialize reports the manifest id and version", () => {
        const plugin = launched.initializeResult.plugin as { id?: string; version?: string } | undefined;
        if (plugin?.id !== launched.manifest.id || plugin?.version !== launched.manifest.version) {
          return `initialize returned ${JSON.stringify(plugin)}, manifest has ${launched.manifest.id}@${launched.manifest.version}`;
        }
        return undefined;
      });
      await recorder.run("plugin runs in a separate process", () =>
        launched.client.pid !== undefined && launched.client.pid !== process.pid ? undefined : "no separate process id",
      );
      const driver = createCutterDriverClient(launched.client);
      await driver.configure({ spoolDir });
      await runDriverChecks(driver, options, recorder, true);
    } finally {
      await launched.client.close();
    }
  } catch (error) {
    recorder.checks.push({
      name: "plugin process launches and initializes",
      ok: false,
      detail: `${error instanceof Error ? error.message : String(error)}${stderr.length ? `\nstderr:\n${stderr.join("\n")}` : ""}`,
    });
  } finally {
    await rm(spoolDir, { recursive: true, force: true });
  }
  return recorder.report();
}
