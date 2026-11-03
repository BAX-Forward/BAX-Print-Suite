// Test helpers: small job builders (mm in, pt stored), an HP-GL/2 subset
// parser for round-trip checks, and a dxf-parser loader that tolerates both
// CommonJS and ES module builds.

import * as dxfParserModule from "dxf-parser";
import type { Contour, CutJob, Point, RegistrationMarks, SemanticTool, ToolAssignment } from "@bax-print/plugin-sdk";
import { makeContour, mmToPt } from "../src/index.js";

export const ptFromMm = (points: readonly [number, number][]): Point[] => points.map(([x, y]) => [mmToPt(x), mmToPt(y)]);

export function rectMm(id: string, tool: SemanticTool, x0: number, y0: number, x1: number, y1: number): Contour {
  return makeContour({ id, tool, closed: true, points: ptFromMm([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) });
}

export function polylineMm(id: string, tool: SemanticTool, points: readonly [number, number][], closed = false): Contour {
  return makeContour({ id, tool, closed, points: ptFromMm(points) });
}

export function jobOf(args: {
  contours: Contour[];
  toolMap?: Record<string, ToolAssignment>;
  widthMm?: number;
  heightMm?: number;
  marks?: RegistrationMarks;
  options?: Record<string, unknown>;
  jobId?: string;
}): CutJob {
  return {
    jobId: args.jobId ?? "job-0001",
    contours: args.contours,
    toolMap: args.toolMap ?? Object.fromEntries([...new Set(args.contours.map((c) => String(c.tool)))].map((t) => [t, { toolId: t }])),
    frame: { widthPt: mmToPt(args.widthMm ?? 200), heightPt: mmToPt(args.heightMm ?? 100) },
    ...(args.marks ? { marks: args.marks } : {}),
    options: args.options ?? {},
  };
}

export function marksMm(centers: readonly [number, number][], diameterMm: number, extra: Partial<RegistrationMarks> = {}): RegistrationMarks {
  return {
    marks: centers.map(([x, y], i) => ({ id: `m${i}`, xPt: mmToPt(x), yPt: mmToPt(y), dPt: mmToPt(diameterMm) })),
    originMarkId: "m0",
    ...extra,
  };
}

export interface ParsedHpglPath {
  pen: number;
  points: Point[];
}

/** Parses the HP-GL/2 subset our writer emits (IN, SP, PU, PD, VS, FS). */
export function parseHpgl(text: string): { commands: string[]; paths: ParsedHpglPath[] } {
  const commands = text
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const paths: ParsedHpglPath[] = [];
  let pen = 0;
  let current: ParsedHpglPath | undefined;
  for (const command of commands) {
    const op = command.slice(0, 2);
    const args = command.slice(2).length > 0 ? command.slice(2).split(",").map(Number) : [];
    if (args.some((n) => !Number.isInteger(n))) throw new Error(`non-integer coordinate in "${command}"`);
    switch (op) {
      case "SP":
        pen = args[0] ?? 0;
        break;
      case "PU":
        current = undefined;
        if (args.length >= 2) {
          current = { pen, points: [[args[args.length - 2], args[args.length - 1]]] };
          paths.push(current);
        }
        break;
      case "PD":
        if (!current) throw new Error("PD without a preceding PU x,y");
        if (args.length % 2 !== 0) throw new Error(`odd coordinate count in "${command}"`);
        for (let i = 0; i < args.length; i += 2) current.points.push([args[i], args[i + 1]]);
        break;
      default:
        break;
    }
  }
  return { commands, paths };
}

export interface ParsedDxfEntity {
  type: string;
  layer: string;
  shape?: boolean;
  vertices?: { x: number; y: number }[];
  center?: { x: number; y: number };
  radius?: number;
  text?: string;
}

export interface ParsedDxf {
  header: Record<string, unknown>;
  tables: { layer: { layers: Record<string, { name: string }> } };
  entities: ParsedDxfEntity[];
}

type DxfParserCtor = new () => { parseSync(text: string): unknown };

export function parseDxf(text: string): ParsedDxf {
  const mod = dxfParserModule as unknown as { default?: unknown };
  const nested = (mod.default as { default?: unknown } | undefined)?.default;
  const Parser = (typeof nested === "function" ? nested : typeof mod.default === "function" ? mod.default : mod) as DxfParserCtor;
  return new Parser().parseSync(text) as ParsedDxf;
}

/** Joins DXF group lines with CRLF, the way R12 goldens are stored. */
export const crlf = (lines: readonly string[]): string => `${lines.join("\r\n")}\r\n`;
