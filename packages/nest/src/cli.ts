import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { impose, type ImposeSource, type SourceBox } from "./impose.js";
import { layoutToJson } from "./layout.js";
import { nest } from "./nesters.js";
import { toSvg } from "./svg.js";
import type {
  Algorithm,
  GrainLock,
  NestItem,
  NestOptions,
  RollMedia,
  Rotation,
  RotationPolicy,
  SortOrder,
} from "./types.js";
import { parseLength, parseMargins, pointsTo, type LengthUnit } from "./units.js";

export interface CliIo {
  readonly cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** An entry of items.json: a NestItem plus where its art lives. Sizes may be unit strings. */
export interface CliItemSource {
  readonly itemId: string;
  readonly path: string;
  readonly pageIndex: number;
  readonly box: SourceBox;
}

export interface ParsedItems {
  readonly items: NestItem[];
  readonly sources: CliItemSource[];
}

export const USAGE = `Usage: bps nest --roll <len> [options] items.json

Lengths accept mm, cm, in or pt (bare numbers are points).

  --roll <len>          roll width (required)
  --margins <len>       all margins, or left,right,lead,trail (default 0)
  --gutter <len>        gap between items (default 0)
  --max-length <len>    split into panels of at most this length
  --rotation <policy>   default for items without one: none | 90 | any (default none)
  --algorithm <name>    maxrects | skyline | auto (default auto)
  --heuristic <name>    maxrects: bssf|blsf|baf|bl, skyline: bl|mwf
  --sort <order>        area-desc | height-desc | width-desc | perimeter-desc | maxside-desc | input
  --seed <n>            seed for auto (default 1)
  --time-budget <ms>    auto time budget (default 500)
  -o, --output <file>   imposed PDF
  --svg <file>          SVG preview
  --json <file>         layout JSON
  -h, --help            this text

items.json is an array of NestItem objects; each may add "pdf" (path relative to
items.json), "pageIndex" (default 0) and "box" ("trim" | "bleed", default "trim").
"width", "height" and "bleed" may be given as unit strings instead of *Pt numbers.
`;

const ROTATION_POLICIES: readonly RotationPolicy[] = ["none", "90", "any"];
const ALGORITHMS: readonly Algorithm[] = ["maxrects", "skyline", "auto"];
const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];
const GRAINS: readonly GrainLock[] = ["along-roll", "across-roll"];
const BOXES: readonly SourceBox[] = ["trim", "bleed"];
const REPORT_UNIT: LengthUnit = "mm";

class UsageError extends Error {}

const defaultIo: CliIo = {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function oneOf<T>(allowed: readonly T[], value: unknown): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

function requireLength(name: string, value: string | undefined, fallback?: number): number {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new UsageError(`--${name} is required`);
  }
  const parsed = parseLength(value);
  if (parsed === undefined || parsed < 0) throw new UsageError(`--${name}: invalid length "${value}"`);
  return parsed;
}

function optionalNumber(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`--${name}: not a number "${value}"`);
  return parsed;
}

/** A number of points, or a unit string; NaN when missing or malformed (nest reports invalid-size). */
function lengthField(record: Record<string, unknown>, ptKey: string, unitKey: string): number | undefined {
  const pt = record[ptKey];
  if (typeof pt === "number") return pt;
  const text = record[unitKey];
  if (typeof text === "number") return text;
  if (typeof text === "string") return parseLength(text) ?? Number.NaN;
  return undefined;
}

function parseLock(value: unknown): NestItem["lock"] {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const grain = oneOf(GRAINS, record.grain);
  const orientation = oneOf(ROTATIONS, record.orientation);
  if (grain === undefined && orientation === undefined) return undefined;
  return { ...(grain ? { grain } : {}), ...(orientation !== undefined ? { orientation } : {}) };
}

/** Maps items.json content to NestItems and art sources. Bad sizes are left for nest() to report. */
export function parseItems(raw: unknown, defaultRotation: RotationPolicy, baseDir: string): ParsedItems {
  if (!Array.isArray(raw)) throw new UsageError("items.json must contain an array");
  const items: NestItem[] = [];
  const sources: CliItemSource[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null) throw new UsageError(`items.json entry ${index} is not an object`);
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" || typeof record.id === "number" ? String(record.id) : `item-${index + 1}`;
    const bleed = lengthField(record, "bleedPt", "bleed");
    const quantity = typeof record.quantity === "number" ? record.quantity : 1;
    const lock = parseLock(record.lock);
    items.push({
      id,
      widthPt: lengthField(record, "widthPt", "width") ?? Number.NaN,
      heightPt: lengthField(record, "heightPt", "height") ?? Number.NaN,
      quantity,
      rotation: oneOf(ROTATION_POLICIES, record.rotation) ?? defaultRotation,
      ...(bleed !== undefined ? { bleedPt: bleed } : {}),
      ...(lock ? { lock } : {}),
      ...(typeof record.group === "string" ? { group: record.group } : {}),
      ...(typeof record.jobId === "string" ? { jobId: record.jobId } : {}),
    });
    if (typeof record.pdf === "string") {
      sources.push({
        itemId: id,
        path: resolve(baseDir, record.pdf),
        pageIndex: typeof record.pageIndex === "number" ? record.pageIndex : 0,
        box: oneOf(BOXES, record.box) ?? "trim",
      });
    }
  }
  return { items, sources };
}

async function loadSources(sources: readonly CliItemSource[]): Promise<Map<string, ImposeSource>> {
  const bytesByPath = new Map<string, Uint8Array>();
  const result = new Map<string, ImposeSource>();
  for (const source of sources) {
    let bytes = bytesByPath.get(source.path);
    if (!bytes) {
      bytes = new Uint8Array(await readFile(source.path));
      bytesByPath.set(source.path, bytes);
    }
    result.set(source.itemId, { pdfBytes: bytes, pageIndex: source.pageIndex, box: source.box });
  }
  return result;
}

/** Runs `bps nest ...`. Returns the process exit code (0 ok, 1 failure, 2 usage error). */
export async function runCli(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  const args = argv[0] === "nest" ? argv.slice(1) : [...argv];
  try {
    return await run(args, io);
  } catch (error) {
    if (error instanceof UsageError || (error instanceof TypeError && "code" in error)) {
      io.stderr(`bps nest: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    io.stderr(`bps nest: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function run(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      roll: { type: "string" },
      margins: { type: "string" },
      gutter: { type: "string" },
      "max-length": { type: "string" },
      rotation: { type: "string" },
      algorithm: { type: "string" },
      heuristic: { type: "string" },
      sort: { type: "string" },
      seed: { type: "string" },
      "time-budget": { type: "string" },
      output: { type: "string", short: "o" },
      svg: { type: "string" },
      json: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  const itemsArg = positionals[0];
  if (positionals.length !== 1 || itemsArg === undefined) throw new UsageError("expected exactly one items.json");

  const margins = values.margins === undefined ? { left: 0, right: 0, lead: 0, trail: 0 } : parseMargins(values.margins);
  if (!margins) throw new UsageError(`--margins: invalid value "${values.margins}"`);
  const maxLength = values["max-length"] === undefined ? undefined : requireLength("max-length", values["max-length"]);
  const media: RollMedia = {
    widthPt: requireLength("roll", values.roll),
    margins,
    ...(maxLength !== undefined ? { maxLengthPt: maxLength } : {}),
  };
  const rotation = values.rotation === undefined ? "none" : oneOf(ROTATION_POLICIES, values.rotation);
  if (!rotation) throw new UsageError(`--rotation: expected none, 90 or any`);
  const algorithm = values.algorithm === undefined ? "auto" : oneOf(ALGORITHMS, values.algorithm);
  if (!algorithm) throw new UsageError(`--algorithm: expected maxrects, skyline or auto`);
  const seed = optionalNumber("seed", values.seed);
  const timeBudgetMs = optionalNumber("time-budget", values["time-budget"]);
  const opts: NestOptions = {
    gutterPt: requireLength("gutter", values.gutter, 0),
    algorithm,
    ...(values.heuristic !== undefined ? { heuristic: values.heuristic } : {}),
    ...(values.sort !== undefined ? { sort: values.sort as SortOrder } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(timeBudgetMs !== undefined ? { timeBudgetMs } : {}),
  };

  const itemsPath = resolve(io.cwd, itemsArg);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(itemsPath, "utf8"));
  } catch (error) {
    throw new UsageError(`cannot read ${itemsArg}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { items, sources } = parseItems(raw, rotation, dirname(itemsPath));
  const layout = nest(media, items, opts);

  if (values.json) await writeFile(resolve(io.cwd, values.json), `${layoutToJson(layout, { space: 2 })}\n`);
  if (values.svg) await writeFile(resolve(io.cwd, values.svg), toSvg(layout));
  if (values.output) {
    const pdf = await impose(layout, await loadSources(sources), {
      onWarning: (warning) => io.stderr(`warning: ${warning.message}\n`),
    });
    await writeFile(resolve(io.cwd, values.output), pdf);
  }

  const length = pointsTo(layout.lengthUsedPt, REPORT_UNIT).toFixed(1);
  io.stdout(
    `${layout.placements.length} placed, length ${length} ${REPORT_UNIT}, ` +
      `utilization ${(layout.utilization * 100).toFixed(1)}%, ${layout.panels.length} panel(s), ${layout.algorithm}\n`,
  );
  for (const entry of layout.unplaced) {
    io.stderr(`unplaced: ${entry.itemId} ×${entry.copies} (${entry.reason})\n`);
  }
  return 0;
}
