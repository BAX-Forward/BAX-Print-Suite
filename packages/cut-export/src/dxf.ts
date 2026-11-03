// AutoCAD R12 ASCII DXF writer (spec 004 Part C, format "dxf"). Source: the
// public AutoCAD Release 12 DXF reference. $ACADVER AC1009, CRLF line endings,
// POLYLINE/VERTEX/SEQEND entities (LWPOLYLINE is R14+), fixed 4 decimals with a
// "." separator regardless of locale. R12 has no $INSUNITS, so units are stated
// in a 999 comment.

import { CutterDriverError, type CutJob, type Point } from "@bax-print/plugin-sdk";
import { createFrameTransform, FRAME_OPTIONS_SCHEMA, parseFrameOptions, type FrameOptions } from "./frame.js";
import { formatFixed, MM_PER_INCH, ptToMm, roundHalfAwayFromZero } from "./geometry.js";

export const DEFAULT_DXF_LAYER_NAMES: Readonly<Record<string, string>> = {
  kiss: "CUT_KISS",
  thru: "CUT_THRU",
  crease: "CREASE",
  pen: "PEN",
};

export interface DxfOptions extends FrameOptions {
  units?: "mm" | "in";
  /** User layer names per tool id (checked first) or semantic tool. */
  layerNames?: Record<string, string>;
  /** Default layer names per semantic tool. Default DEFAULT_DXF_LAYER_NAMES. */
  defaultLayerNames?: Readonly<Record<string, string>>;
  /** Adds a TEXT label with the contour id at each contour start. */
  labels?: boolean;
  textHeightMm?: number;
  /** When set, registration marks are written as CIRCLE entities on this layer. */
  markLayer?: string;
}

export const DXF_OPTIONS_SCHEMA = {
  type: "object",
  properties: {
    ...FRAME_OPTIONS_SCHEMA,
    units: { type: "string", enum: ["mm", "in"], default: "mm" },
    layerNames: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
    labels: { type: "boolean", default: false },
    textHeightMm: { type: "number", exclusiveMinimum: 0, default: 2.5 },
  },
  additionalProperties: true,
} as const;

/** Validates DXF options taken from untrusted `CutJob.options`. Unknown keys are ignored. */
export function parseDxfOptions(raw: Record<string, unknown>): DxfOptions {
  const out: DxfOptions = { ...parseFrameOptions(raw) };
  if (raw.units !== undefined) {
    if (raw.units !== "mm" && raw.units !== "in") throw new CutterDriverError("invalid-options", 'units must be "mm" or "in"');
    out.units = raw.units;
  }
  if (raw.layerNames !== undefined) out.layerNames = parseLayerNames(raw.layerNames);
  if (raw.labels !== undefined) {
    if (typeof raw.labels !== "boolean") throw new CutterDriverError("invalid-options", "labels must be a boolean");
    out.labels = raw.labels;
  }
  if (raw.textHeightMm !== undefined) {
    if (typeof raw.textHeightMm !== "number" || !(raw.textHeightMm > 0)) throw new CutterDriverError("invalid-options", "textHeightMm must be > 0");
    out.textHeightMm = raw.textHeightMm;
  }
  return out;
}

export function parseLayerNames(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CutterDriverError("invalid-options", "layerNames must be an object");
  for (const [key, name] of Object.entries(raw)) {
    if (typeof name !== "string" || name.trim().length === 0) throw new CutterDriverError("invalid-options", `layerNames.${key} must be a non-empty string`);
  }
  return { ...(raw as Record<string, string>) };
}

/** Layer name lookup shared by layer-based formats: user name by tool id, user name by tool, default by tool, tool. */
export function resolveLayerName(
  tool: string,
  toolId: string | undefined,
  layerNames: Record<string, string> | undefined,
  defaults: Readonly<Record<string, string>>,
): string {
  return (toolId !== undefined ? layerNames?.[toolId] : undefined) ?? layerNames?.[tool] ?? defaults[tool] ?? tool;
}

/** R12 layer names allow letters, digits, "$", "-" and "_" (max 31 characters). */
export function sanitizeDxfLayerName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9$_-]/g, "_").slice(0, 31);
  return cleaned.length > 0 ? cleaned : "0";
}

type Pair = [code: number, value: string];

class Extents {
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;

  add(x: number, y: number, r = 0): void {
    this.minX = Math.min(this.minX, x - r);
    this.minY = Math.min(this.minY, y - r);
    this.maxX = Math.max(this.maxX, x + r);
    this.maxY = Math.max(this.maxY, y + r);
  }

  get empty(): boolean {
    return this.minX === Infinity;
  }
}

export interface DxfResult {
  text: string;
  warnings: string[];
}

export function writeDxf(job: CutJob, options: DxfOptions = {}): DxfResult {
  const units = options.units ?? "mm";
  const unitScale = units === "in" ? 1 / MM_PER_INCH : 1;
  const toFrame = createFrameTransform(job, options);
  const num = (v: number): string => formatFixed(v, 4);
  // Round to output precision before comparing points, so dedupe matches what is written.
  const toOutput = (p: Point): Point => {
    const [x, y] = toFrame(p);
    return [roundHalfAwayFromZero(x * unitScale * 1e4) / 1e4, roundHalfAwayFromZero(y * unitScale * 1e4) / 1e4];
  };
  const defaults = options.defaultLayerNames ?? DEFAULT_DXF_LAYER_NAMES;
  const warnings: string[] = [];
  const layers: string[] = [];
  const useLayer = (name: string): string => {
    const layer = sanitizeDxfLayerName(name);
    if (!layers.includes(layer)) layers.push(layer);
    return layer;
  };
  const extents = new Extents();
  const entities: Pair[] = [];
  const zero = num(0);

  for (const contour of job.contours) {
    const pts: Point[] = [];
    for (const p of contour.points.map(toOutput)) {
      const last = pts[pts.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
    }
    if (contour.closed && pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (pts.length < 2) {
      warnings.push(`contour ${contour.id}: fewer than 2 distinct points after rounding, skipped`);
      continue;
    }
    const layer = useLayer(resolveLayerName(contour.tool, job.toolMap[contour.tool]?.toolId, options.layerNames, defaults));
    entities.push([0, "POLYLINE"], [8, layer], [66, "1"], [10, zero], [20, zero], [30, zero], [70, contour.closed ? "1" : "0"]);
    for (const [x, y] of pts) {
      extents.add(x, y);
      entities.push([0, "VERTEX"], [8, layer], [10, num(x)], [20, num(y)], [30, zero]);
    }
    entities.push([0, "SEQEND"], [8, layer]);
    if (options.labels) {
      const height = (options.textHeightMm ?? 2.5) * unitScale;
      entities.push([0, "TEXT"], [8, layer], [10, num(pts[0][0])], [20, num(pts[0][1])], [30, zero], [40, num(height)], [1, contour.id]);
    }
  }

  if (options.markLayer && job.marks && job.marks.marks.length > 0) {
    const layer = useLayer(options.markLayer);
    const [sx, sy] = options.scale ?? [1, 1];
    if (sx !== sy) warnings.push("non-uniform scale: registration circles use the X scale for their radius");
    for (const mark of job.marks.marks) {
      const [x, y] = toOutput([mark.xPt, mark.yPt]);
      const r = ptToMm(mark.dPt / 2) * sx * unitScale;
      extents.add(x, y, r);
      entities.push([0, "CIRCLE"], [8, layer], [10, num(x)], [20, num(y)], [30, zero], [40, num(r)]);
    }
  }

  const [minX, minY, maxX, maxY] = extents.empty ? [0, 0, 0, 0] : [extents.minX, extents.minY, extents.maxX, extents.maxY];
  const pairs: Pair[] = [
    [999, `BAX Print Suite cut export; units=${units}`],
    [0, "SECTION"], [2, "HEADER"],
    [9, "$ACADVER"], [1, "AC1009"],
    [9, "$EXTMIN"], [10, num(minX)], [20, num(minY)], [30, zero],
    [9, "$EXTMAX"], [10, num(maxX)], [20, num(maxY)], [30, zero],
    [0, "ENDSEC"],
    [0, "SECTION"], [2, "TABLES"],
    [0, "TABLE"], [2, "LTYPE"], [70, "1"],
    [0, "LTYPE"], [2, "CONTINUOUS"], [70, "0"], [3, "Solid line"], [72, "65"], [73, "0"], [40, zero],
    [0, "ENDTAB"],
    [0, "TABLE"], [2, "LAYER"], [70, String(layers.length)],
    ...layers.flatMap((name): Pair[] => [[0, "LAYER"], [2, name], [70, "0"], [62, "7"], [6, "CONTINUOUS"]]),
    [0, "ENDTAB"],
    [0, "ENDSEC"],
    [0, "SECTION"], [2, "ENTITIES"],
    ...entities,
    [0, "ENDSEC"],
    [0, "EOF"],
  ];
  return { text: pairs.map(([code, value]) => `${code}\r\n${value}\r\n`).join(""), warnings };
}
