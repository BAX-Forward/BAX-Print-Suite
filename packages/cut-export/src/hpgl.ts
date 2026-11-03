// HP-GL/2 subset writer (spec 004 Part C, format "hpgl"). Source: the public
// HP-GL/2 language reference. Commands used: IN, SP, PU, PD, and the
// opt-in VS / FS. Plotter units: 40 per mm (1016 per inch), integers,
// half-away-from-zero rounding.

import { CutterDriverError, type CutJob, type Point } from "@bax-print/plugin-sdk";
import { createFrameTransform, FRAME_OPTIONS_SCHEMA, parseFrameOptions, type FrameOptions } from "./frame.js";
import { formatCompact, roundHalfAwayFromZero } from "./geometry.js";

export const HPGL_UNITS_PER_MM = 40;
export const HPGL_MAX_PAIRS_PER_PD = 256;
export const DEFAULT_PEN_MAP: Readonly<Record<string, number>> = { kiss: 1, thru: 2, crease: 3, pen: 4 };

export interface HpglOptions extends FrameOptions {
  /** Pen number per tool id (checked first) or semantic tool. Merged over DEFAULT_PEN_MAP. */
  penMap?: Record<string, number>;
  /** Written after each `;`. Default "\n". */
  lineEnding?: "" | "\n";
  /** Coordinate pairs per PD command, 1..256. */
  maxPairsPerPD?: number;
  /** Emit `VS` (device-dependent). Value: toolMap speed, else `velocity`. */
  sendVelocity?: boolean;
  /** Emit `FS` (not in the HP-GL/2 base set; device-dependent). Value: toolMap force, else `force`. */
  sendForce?: boolean;
  velocity?: number;
  force?: number;
}

export const HPGL_OPTIONS_SCHEMA = {
  type: "object",
  properties: {
    ...FRAME_OPTIONS_SCHEMA,
    penMap: { type: "object", additionalProperties: { type: "integer", minimum: 0 }, default: DEFAULT_PEN_MAP },
    lineEnding: { type: "string", enum: ["", "\n"], default: "\n" },
    maxPairsPerPD: { type: "integer", minimum: 1, maximum: HPGL_MAX_PAIRS_PER_PD, default: HPGL_MAX_PAIRS_PER_PD },
    sendVelocity: { type: "boolean", default: false, "x-device-dependent": true },
    sendForce: { type: "boolean", default: false, "x-device-dependent": true },
    velocity: { type: "number", exclusiveMinimum: 0, "x-device-dependent": true },
    force: { type: "number", exclusiveMinimum: 0, "x-device-dependent": true },
  },
  additionalProperties: true,
} as const;

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new CutterDriverError("invalid-options", `${name} must be a positive number`);
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new CutterDriverError("invalid-options", `${name} must be a boolean`);
  return value;
}

/** Validates HPGL options taken from untrusted `CutJob.options`. Unknown keys are ignored. */
export function parseHpglOptions(raw: Record<string, unknown>): HpglOptions {
  const out: HpglOptions = { ...parseFrameOptions(raw) };
  if (raw.penMap !== undefined) {
    if (typeof raw.penMap !== "object" || raw.penMap === null || Array.isArray(raw.penMap)) {
      throw new CutterDriverError("invalid-options", "penMap must be an object of pen numbers");
    }
    for (const [key, pen] of Object.entries(raw.penMap)) {
      if (!Number.isInteger(pen) || (pen as number) < 0) throw new CutterDriverError("invalid-options", `penMap.${key} must be a non-negative integer`);
    }
    out.penMap = { ...(raw.penMap as Record<string, number>) };
  }
  if (raw.lineEnding !== undefined) {
    if (raw.lineEnding !== "" && raw.lineEnding !== "\n") throw new CutterDriverError("invalid-options", 'lineEnding must be "" or "\\n"');
    out.lineEnding = raw.lineEnding;
  }
  if (raw.maxPairsPerPD !== undefined) {
    const n = raw.maxPairsPerPD;
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > HPGL_MAX_PAIRS_PER_PD) {
      throw new CutterDriverError("invalid-options", `maxPairsPerPD must be an integer in 1..${HPGL_MAX_PAIRS_PER_PD}`);
    }
    out.maxPairsPerPD = n as number;
  }
  const sendVelocity = optionalBoolean(raw.sendVelocity, "sendVelocity");
  if (sendVelocity !== undefined) out.sendVelocity = sendVelocity;
  const sendForce = optionalBoolean(raw.sendForce, "sendForce");
  if (sendForce !== undefined) out.sendForce = sendForce;
  if (raw.velocity !== undefined) out.velocity = positiveNumber(raw.velocity, "velocity");
  if (raw.force !== undefined) out.force = positiveNumber(raw.force, "force");
  return out;
}

/** Contour points in integer plotter units, without consecutive duplicates; closed contours end at their start. */
function devicePoints(points: readonly Point[], closed: boolean, toFrame: (p: Point) => Point): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const [xMm, yMm] = toFrame(p);
    const q: Point = [roundHalfAwayFromZero(xMm * HPGL_UNITS_PER_MM), roundHalfAwayFromZero(yMm * HPGL_UNITS_PER_MM)];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  if (closed && out.length > 1) {
    const [first, last] = [out[0], out[out.length - 1]];
    if (first[0] !== last[0] || first[1] !== last[1]) out.push(first);
  }
  return out;
}

export interface HpglResult {
  text: string;
  warnings: string[];
}

export function writeHpgl(job: CutJob, options: HpglOptions = {}): HpglResult {
  const toFrame = createFrameTransform(job, options);
  const lineEnding = options.lineEnding ?? "\n";
  const maxPairs = options.maxPairsPerPD ?? HPGL_MAX_PAIRS_PER_PD;
  const warnings = new Set<string>();
  const commands: string[] = ["IN"];
  let currentPen: number | undefined;
  let currentVelocity: number | undefined;
  let currentForce: number | undefined;

  for (const contour of job.contours) {
    const pts = devicePoints(contour.points, contour.closed, toFrame);
    if (pts.length < 2) {
      warnings.add(`contour ${contour.id}: fewer than 2 distinct points after rounding, skipped`);
      continue;
    }
    const assignment = job.toolMap[contour.tool];
    const pen = options.penMap?.[assignment?.toolId ?? ""] ?? options.penMap?.[contour.tool] ?? DEFAULT_PEN_MAP[contour.tool];
    const resolvedPen = pen ?? 1;
    if (pen === undefined) warnings.add(`tool "${contour.tool}": no pen number in penMap, using SP1`);
    if (resolvedPen !== currentPen) {
      commands.push(`SP${resolvedPen}`);
      currentPen = resolvedPen;
    }
    if (options.sendVelocity) {
      const velocity = assignment?.speed ?? options.velocity;
      if (velocity !== undefined && velocity !== currentVelocity) {
        commands.push(`VS${formatCompact(velocity, 2)}`);
        currentVelocity = velocity;
      }
    }
    if (options.sendForce) {
      const force = assignment?.force ?? options.force;
      if (force !== undefined && force !== currentForce) {
        commands.push(`FS${formatCompact(force, 2)}`);
        currentForce = force;
      }
    }
    commands.push(`PU${pts[0][0]},${pts[0][1]}`);
    for (let i = 1; i < pts.length; i += maxPairs) {
      commands.push(`PD${pts.slice(i, i + maxPairs).map(([x, y]) => `${x},${y}`).join(",")}`);
    }
  }
  commands.push("PU", "SP0");
  return { text: commands.map((c) => `${c};${lineEnding}`).join(""), warnings: [...warnings] };
}
