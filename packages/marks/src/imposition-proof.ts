/**
 * Imposition proof sheet (Spec 036c): a schematic PDF of a Spec 036a n-up or
 * booklet plan, one PDF page per sheet side. Each page shows the sheet outline,
 * the slot frames with their page number or BLANK, crop marks at every slot
 * corner, n-up gutters as grey bands, the booklet spine as a dashed fold line
 * with fold ticks outside the sheet, and a header naming the side (plus, for a
 * booklet sheet, its creep). No page content is placed. Text uses the BPS
 * Stroke font in DeviceGray; every label is wrapped in a marked-content span
 * with its ActualText (ISO 32000-2 §14.9.4) so the words survive extraction.
 *
 * The plan types are structural copies of the nest planner output, so marks
 * does not depend on nest. Lengths are points, as in the plans. Coordinates
 * from `planImpositionProof()` are in the PDF page frame: origin at the
 * bottom-left corner, y up, the sheet inset by the border.
 */
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { MarkSpecError } from "./errors.js";
import { formatIssues } from "./schema.js";
import { fontMetrics, layoutText, normalizeForFont } from "./stroke-font.js";
import { PT_PER_MM, mmToPt, ptToMm } from "./units.js";

/** Most sheet sides (PDF pages) one proof may hold. */
export const MAX_PROOF_SIDES = 200;

/** A page number (1-based) or an empty slot, as in the nest plans. */
export type ImpositionProofPageSlot = number | "blank";

/** Structurally compatible with the nest `NUpPlacement`. */
export interface ImpositionProofNUpPlacement {
  readonly index: number;
  readonly row: number;
  readonly col: number;
  /** Bottom-left of the footprint, in sheet coordinates (y up), points. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

/** Structurally compatible with the nest `NUpPlan`. */
export interface ImpositionProofNUpPlan {
  readonly rows: number;
  readonly cols: number;
  readonly rotation: number;
  readonly placements: readonly ImpositionProofNUpPlacement[];
  readonly sheets: readonly { readonly index: number; readonly pages: readonly ImpositionProofPageSlot[] }[];
}

/** Structurally compatible with the nest `BookletSheet`. */
export interface ImpositionProofBookletSheet {
  readonly index: number;
  readonly signature: number;
  readonly position: number;
  readonly front: readonly [ImpositionProofPageSlot, ImpositionProofPageSlot];
  readonly back: readonly [ImpositionProofPageSlot, ImpositionProofPageSlot];
  /** Points. */
  readonly creep: number;
}

/** Structurally compatible with the nest `BookletPlan`. */
export interface ImpositionProofBookletPlan {
  readonly signatureCount: number;
  readonly binding: "left" | "right";
  readonly sheets: readonly ImpositionProofBookletSheet[];
}

export type ImpositionProofPlan = ImpositionProofNUpPlan | ImpositionProofBookletPlan;

const BLANK_LABEL = "BLANK";
const SLOT_FONT_PT = 12;
/** Largest share of a slot's width and height a slot label may take. */
const SLOT_TEXT_FILL = 0.8;
const HEADER_FONT_PT = 8;
const HEADER_LINES = 3;
const HEADER_PAD_PT = mmToPt(3);
const HEADER_LINE_PT = mmToPt(fontMetrics(HEADER_FONT_PT).lineHeightMm);
const HEADER_BAND_PT = HEADER_LINES * HEADER_LINE_PT + 2 * HEADER_PAD_PT;
const GUTTER_GRAY = 0.85;
const BLANK_GRAY = 0.93;
const SHEET_LINE_PT = 1;
const FRAME_LINE_PT = 0.5;
const MARK_LINE_PT = 0.25;
const FOLD_DASH = "[3 2] 0 d";
/** Largest sheet side accepted, leaving room for the border within the PDF page limit. */
const MAX_SHEET_PT = 10_000;
/** Flat booklet sheet when none is given: two A5 portrait pages side by side. */
const DEFAULT_BOOKLET_SHEET = { width: mmToPt(297), height: mmToPt(210) };
const PROOF_TITLE = "Imposition proof";
const EPS_PT = 1e-6;
const FACES: readonly ImpositionProofFace[] = ["front", "back"];
const NONE: readonly never[] = Object.freeze([]);

function num(v: number, digits = 3): string {
  const r = Number(v.toFixed(digits));
  return String(Object.is(r, -0) ? 0 : r);
}

/** Points as millimetres to 2 decimals. */
function mmText(pt: number): string {
  return num(ptToMm(pt), 2);
}

const Count = z.number().int().min(1);
const Index = z.number().int().min(0);
const Coord = z.number().finite().min(0);
const Length = z.number().finite().positive();
const PageSlotSchema = z.union([z.number().int().min(1), z.literal("blank")]);

const NUpPlanSchema = z
  .object({
    rows: Count,
    cols: Count,
    rotation: z.number().finite(),
    placements: z
      .array(
        z.object({
          index: Index,
          row: Index,
          col: Index,
          x: Coord,
          y: Coord,
          width: Length,
          height: Length,
          rotation: z.number().finite(),
        }),
      )
      .min(1),
    sheets: z.array(z.object({ index: Index, pages: z.array(PageSlotSchema) })).min(1, "the plan has no sheets"),
  })
  .superRefine((plan, ctx) => {
    const issue = (path: (string | number)[], message: string): void =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const grid = `${plan.rows} x ${plan.cols} grid`;
    if (plan.placements.length === plan.rows * plan.cols) {
      plan.placements.forEach((p, i) => {
        if (p.row < plan.rows && p.col < plan.cols) return;
        issue(["placements", i], `row ${p.row}, col ${p.col} is outside the ${grid}`);
      });
    } else {
      issue(["placements"], `${plan.placements.length} placements for a ${grid}`);
    }
    plan.sheets.forEach((s, i) => {
      if (s.pages.length === plan.placements.length) return;
      issue(["sheets", i, "pages"], `${s.pages.length} pages for ${plan.placements.length} slots`);
    });
  });

const BookletSideSchema = z.tuple([PageSlotSchema, PageSlotSchema]);

const BookletPlanSchema = z
  .object({
    signatureCount: Count,
    binding: z.enum(["left", "right"]),
    sheets: z
      .array(
        z.object({
          index: Index,
          signature: Index,
          position: Index,
          front: BookletSideSchema,
          back: BookletSideSchema,
          creep: z.number().finite().min(0),
        }),
      )
      .min(1, "the plan has no sheets"),
  })
  .superRefine((plan, ctx) => {
    plan.sheets.forEach((s, i) => {
      if (s.signature < plan.signatureCount) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sheets", i, "signature"],
        message: `signature ${s.signature} is outside the plan's ${plan.signatureCount} signatures`,
      });
    });
  });

type ParsedNUp = z.output<typeof NUpPlanSchema>;
type ParsedBooklet = z.output<typeof BookletPlanSchema>;
export type ParsedPlan = { readonly kind: "n-up"; readonly plan: ParsedNUp } | { readonly kind: "booklet"; readonly plan: ParsedBooklet };

/** An object with `placements` is read as an n-up plan, anything else as a booklet plan. */
export function parsePlan(input: unknown): ParsedPlan {
  if (input instanceof Object && "placements" in input) {
    const parsed = NUpPlanSchema.safeParse(input);
    if (parsed.success) return { kind: "n-up", plan: parsed.data };
    throw new MarkSpecError("invalid imposition plan", formatIssues(parsed.error));
  }
  const parsed = BookletPlanSchema.safeParse(input);
  if (parsed.success) return { kind: "booklet", plan: parsed.data };
  throw new MarkSpecError("invalid imposition plan", formatIssues(parsed.error));
}

function assertSideCap(plan: ParsedPlan): void {
  const sides = plan.kind === "n-up" ? plan.plan.sheets.length : 2 * plan.plan.sheets.length;
  if (sides <= MAX_PROOF_SIDES) return;
  throw new MarkSpecError(`imposition plan has ${sides} sheet sides, more than the limit of ${MAX_PROOF_SIDES}`);
}

const SheetSizeSchema = z.object({
  width: z.number().positive().max(MAX_SHEET_PT),
  height: z.number().positive().max(MAX_SHEET_PT),
});

export const ImpositionProofOptionsSchema = z
  .object({
    /**
     * Flat sheet in points. Default for n-up: the placements' extent plus the
     * left margin on the right and top (the planner's equal margins); for a
     * booklet: 297 x 210 mm.
     */
    sheet: SheetSizeSchema.optional(),
    /** Space around the sheet for crop and fold marks. */
    borderMm: z.number().min(5).max(100).default(15),
    /** Gap between a slot corner and its crop marks. */
    cropOffsetMm: z.number().min(0).max(10).default(2),
    cropLengthMm: z.number().min(1).max(20).default(5),
  })
  .superRefine((o, ctx) => {
    const reach = o.cropOffsetMm + o.cropLengthMm;
    if (reach <= o.borderMm + EPS_PT) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["borderMm"],
      message: `crop marks reach ${num(reach)} mm past a slot but the border is ${num(o.borderMm)} mm`,
    });
  });

export type ImpositionProofOptions = z.output<typeof ImpositionProofOptionsSchema>;
export type ImpositionProofOptionsInput = z.input<typeof ImpositionProofOptionsSchema>;

export function parseImpositionProofOptions(input: unknown): ImpositionProofOptions {
  const parsed = ImpositionProofOptionsSchema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  throw new MarkSpecError("invalid imposition proof options", formatIssues(parsed.error));
}

export interface ImpositionProofRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ImpositionProofLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface ImpositionProofSlot {
  readonly page: ImpositionProofPageSlot;
  /** `Page n` or `BLANK`. */
  readonly label: string;
  readonly frame: ImpositionProofRect;
  /** Two per corner: a horizontal and a vertical stroke pointing away from the slot. */
  readonly cropMarks: readonly ImpositionProofLine[];
}

export type ImpositionProofFace = "front" | "back";

export interface ImpositionProofSide {
  /** 1-based PDF page. */
  readonly pageNumber: number;
  readonly widthPt: number;
  readonly heightPt: number;
  /** 0-based plan sheet. */
  readonly sheetIndex: number;
  /** An n-up sheet has a front only. */
  readonly face: ImpositionProofFace;
  readonly sheet: ImpositionProofRect;
  /** In plan order: n-up placement order, booklet left then right. */
  readonly slots: readonly ImpositionProofSlot[];
  /** n-up gutter bands between neighbouring rows and columns. */
  readonly gutters: readonly ImpositionProofRect[];
  /** Booklet spine, drawn dashed across the sheet. */
  readonly foldLines: readonly ImpositionProofLine[];
  /** Booklet spine ticks above and below the sheet. */
  readonly foldMarks: readonly ImpositionProofLine[];
  /** `Sheet n of m - face`, the plan summary and, for a booklet, the creep note. */
  readonly headerLines: readonly string[];
}

interface Size {
  readonly width: number;
  readonly height: number;
}

/** The PDF page around one sheet. */
interface Frame {
  readonly border: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly sheet: ImpositionProofRect;
  readonly cropOffset: number;
  readonly cropLength: number;
}

function rect(x: number, y: number, width: number, height: number): ImpositionProofRect {
  return Object.freeze({ x, y, width, height });
}

function line(x1: number, y1: number, x2: number, y2: number): ImpositionProofLine {
  return Object.freeze({ x1, y1, x2, y2 });
}

function frameFor(size: Size, o: ImpositionProofOptions): Frame {
  const border = mmToPt(o.borderMm);
  return {
    border,
    widthPt: size.width + 2 * border,
    heightPt: size.height + 2 * border + HEADER_BAND_PT,
    sheet: rect(border, border, size.width, size.height),
    cropOffset: mmToPt(o.cropOffsetMm),
    cropLength: mmToPt(o.cropLengthMm),
  };
}

/** Corner with the outward direction on each axis. */
type Corner = readonly [x: number, y: number, dx: number, dy: number];

function cropMarks(r: ImpositionProofRect, offset: number, length: number): readonly ImpositionProofLine[] {
  const right = r.x + r.width;
  const top = r.y + r.height;
  const corners: readonly Corner[] = [
    [r.x, r.y, -1, -1],
    [right, r.y, 1, -1],
    [r.x, top, -1, 1],
    [right, top, 1, 1],
  ];
  const reach = offset + length;
  return Object.freeze(
    corners.flatMap(([x, y, dx, dy]) => [line(x + dx * offset, y, x + dx * reach, y), line(x, y + dy * offset, x, y + dy * reach)]),
  );
}

function slotFor(page: ImpositionProofPageSlot | undefined, slotFrame: ImpositionProofRect, frame: Frame): ImpositionProofSlot {
  if (page === undefined) throw new MarkSpecError("an imposition sheet has fewer pages than slots");
  return Object.freeze({
    page,
    label: page === "blank" ? BLANK_LABEL : `Page ${page}`,
    frame: slotFrame,
    cropMarks: cropMarks(slotFrame, frame.cropOffset, frame.cropLength),
  });
}

type SideParts = Omit<ImpositionProofSide, "pageNumber" | "widthPt" | "heightPt" | "sheet">;

function side(frame: Frame, pageNumber: number, parts: SideParts): ImpositionProofSide {
  return Object.freeze({ pageNumber, widthPt: frame.widthPt, heightPt: frame.heightPt, sheet: frame.sheet, ...parts });
}

function sideTitle(sheetIndex: number, sheetCount: number, face: ImpositionProofFace): string {
  return `Sheet ${sheetIndex + 1} of ${sheetCount} - ${face}`;
}

function bounds(rects: readonly ImpositionProofRect[]): ImpositionProofRect {
  const left = Math.min(...rects.map((r) => r.x));
  const bottom = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const top = Math.max(...rects.map((r) => r.y + r.height));
  return rect(left, bottom, right - left, top - bottom);
}

/** The grid is anchored top-left at the margin, so the left margin also sits above the top row. */
function defaultNUpSheet(placements: readonly ImpositionProofRect[]): Size {
  const b = bounds(placements);
  return { width: b.x + b.width + b.x, height: b.y + b.height + b.x };
}

function assertSlotsOnSheet(placements: readonly ImpositionProofNUpPlacement[], size: Size): void {
  const outside = placements.find((p) => p.x + p.width > size.width + EPS_PT || p.y + p.height > size.height + EPS_PT);
  if (outside === undefined) return;
  throw new MarkSpecError(`slot ${outside.index} reaches past the ${num(size.width)} x ${num(size.height)} pt sheet`);
}

function placementAt(plan: ParsedNUp, row: number, col: number): ImpositionProofNUpPlacement | undefined {
  return plan.placements.find((p) => p.row === row && p.col === col);
}

/** Gap between columns (x) and rows (y), read off the first neighbours of the top-left cell. */
function nUpGutter(plan: ParsedNUp): { readonly x: number; readonly y: number } {
  const origin = placementAt(plan, 0, 0);
  if (origin === undefined) return { x: 0, y: 0 };
  const right = placementAt(plan, 0, 1);
  const below = placementAt(plan, 1, 0);
  return {
    x: right === undefined ? 0 : Math.max(0, right.x - (origin.x + origin.width)),
    y: below === undefined ? 0 : Math.max(0, origin.y - (below.y + below.height)),
  };
}

/** Bands spanning the grid between neighbouring columns and rows, in sheet coordinates. */
function gutterBands(plan: ParsedNUp, gutter: { readonly x: number; readonly y: number }): ImpositionProofRect[] {
  const grid = bounds(plan.placements);
  const bands: ImpositionProofRect[] = [];
  for (let col = 1; col < plan.cols && gutter.x > EPS_PT; col++) {
    const p = placementAt(plan, 0, col);
    if (p === undefined) continue;
    bands.push(rect(p.x - gutter.x, grid.y, gutter.x, grid.height));
  }
  for (let row = 1; row < plan.rows && gutter.y > EPS_PT; row++) {
    const p = placementAt(plan, row, 0);
    if (p === undefined) continue;
    bands.push(rect(grid.x, p.y + p.height, grid.width, gutter.y));
  }
  return bands;
}

function nUpSides(plan: ParsedNUp, o: ImpositionProofOptions): ImpositionProofSide[] {
  const size = o.sheet ?? defaultNUpSheet(plan.placements);
  assertSlotsOnSheet(plan.placements, size);
  const frame = frameFor(size, o);
  const shift = (r: ImpositionProofRect): ImpositionProofRect => rect(r.x + frame.border, r.y + frame.border, r.width, r.height);
  const gutter = nUpGutter(plan);
  const gutters = Object.freeze(gutterBands(plan, gutter).map(shift));
  const slotFrames = plan.placements.map(shift);
  const summary = `${plan.rows} x ${plan.cols} n-up, gutter ${mmText(gutter.x)} x ${mmText(gutter.y)} mm, rotation ${plan.rotation}`;
  const count = plan.sheets.length;
  return plan.sheets.map((sheet, i) =>
    side(frame, i + 1, {
      sheetIndex: i,
      face: "front",
      slots: Object.freeze(slotFrames.map((f, k) => slotFor(sheet.pages[k], f, frame))),
      gutters,
      foldLines: NONE,
      foldMarks: NONE,
      headerLines: Object.freeze([sideTitle(i, count, "front"), summary]),
    }),
  );
}

function bookletSides(plan: ParsedBooklet, o: ImpositionProofOptions): ImpositionProofSide[] {
  const frame = frameFor(o.sheet ?? DEFAULT_BOOKLET_SHEET, o);
  const { sheet } = frame;
  const half = sheet.width / 2;
  const spineX = sheet.x + half;
  const top = sheet.y + sheet.height;
  const leftPage = rect(sheet.x, sheet.y, half, sheet.height);
  const rightPage = rect(spineX, sheet.y, half, sheet.height);
  const reach = frame.cropOffset + frame.cropLength;
  const foldLines = Object.freeze([line(spineX, sheet.y, spineX, top)]);
  const foldMarks = Object.freeze([
    line(spineX, top + frame.cropOffset, spineX, top + reach),
    line(spineX, sheet.y - frame.cropOffset, spineX, sheet.y - reach),
  ]);
  const count = plan.sheets.length;
  return plan.sheets.flatMap((s, i) =>
    FACES.map((face, f) => {
      const [left, right] = s[face];
      return side(frame, 2 * i + f + 1, {
        sheetIndex: i,
        face,
        slots: Object.freeze([slotFor(left, leftPage, frame), slotFor(right, rightPage, frame)]),
        gutters: NONE,
        foldLines,
        foldMarks,
        headerLines: Object.freeze([
          sideTitle(i, count, face),
          `Signature ${s.signature + 1} of ${plan.signatureCount}, sheet ${s.position + 1} from the outside, ${plan.binding} binding`,
          `Creep ${num(s.creep)} pt / ${mmText(s.creep)} mm`,
        ]),
      });
    }),
  );
}

/** Lays out the proof; throws MarkSpecError on a bad, empty or over-limit plan or bad options. */
export function planImpositionProof(
  plan: ImpositionProofPlan,
  options: ImpositionProofOptionsInput = {},
): readonly ImpositionProofSide[] {
  const parsed = parsePlan(plan);
  const opts = parseImpositionProofOptions(options);
  assertSideCap(parsed);
  return Object.freeze(parsed.kind === "n-up" ? nUpSides(parsed.plan, opts) : bookletSides(parsed.plan, opts));
}

function rectOp(r: ImpositionProofRect): string {
  return `${num(r.x)} ${num(r.y)} ${num(r.width)} ${num(r.height)} re`;
}

function pathOps(lines: readonly ImpositionProofLine[]): string[] {
  return lines.flatMap((l) => [`${num(l.x1)} ${num(l.y1)} m`, `${num(l.x2)} ${num(l.y2)} l`]);
}

function fillOps(gray: number, rects: readonly ImpositionProofRect[]): string[] {
  return rects.length === 0 ? [] : [`${gray} g`, ...rects.map(rectOp), "f"];
}

/** ASCII literal string; the labels are generated from numbers and fixed words. */
function pdfLiteral(text: string): string {
  return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

interface TextBox {
  /** Bottom-left of the line, or its centre when `centred`. */
  readonly x: number;
  readonly y: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly centred: boolean;
}

/** One line of stroke text tagged with its ActualText, shrunk to fit the box. */
function textOps(text: string, fontPt: number, box: TextBox): string[] {
  const glyphs = normalizeForFont(text).text;
  const unitWidth = mmToPt(layoutText([glyphs], 1).widthMm);
  const unitHeight = mmToPt(fontMetrics(1).lineHeightMm);
  const size = Math.min(fontPt, box.maxWidth / unitWidth, box.maxHeight / unitHeight);
  const block = layoutText([glyphs], size);
  const x = box.centred ? box.x - mmToPt(block.widthMm) / 2 : box.x;
  const y = box.centred ? box.y - mmToPt(fontMetrics(size).lineHeightMm) / 2 : box.y;
  const ops = [`/Span <</ActualText ${pdfLiteral(text)}>> BDC`, `${num(block.strokeWidthMm * PT_PER_MM)} w`];
  for (const polyline of block.polylines) {
    polyline.forEach((p, i) => ops.push(`${num(x + mmToPt(p.x))} ${num(y + mmToPt(p.y))} ${i === 0 ? "m" : "l"}`));
    ops.push("S");
  }
  ops.push("EMC");
  return ops;
}

function foldOps(s: ImpositionProofSide): string[] {
  if (s.foldLines.length === 0 || s.foldMarks.length === 0) return [];
  return ["/FoldMarks BMC", `${MARK_LINE_PT} w`, FOLD_DASH, ...pathOps(s.foldLines), "S", "[] 0 d", ...pathOps(s.foldMarks), "S", "EMC"];
}

function labelOps(s: ImpositionProofSide): string[] {
  const slotLabels = s.slots.flatMap(({ label, frame: f }) =>
    textOps(label, SLOT_FONT_PT, {
      x: f.x + f.width / 2,
      y: f.y + f.height / 2,
      maxWidth: f.width * SLOT_TEXT_FILL,
      maxHeight: f.height * SLOT_TEXT_FILL,
      centred: true,
    }),
  );
  const header = s.headerLines.flatMap((text, i) =>
    textOps(text, HEADER_FONT_PT, {
      x: s.sheet.x,
      y: s.heightPt - HEADER_PAD_PT - (i + 1) * HEADER_LINE_PT,
      maxWidth: s.widthPt - 2 * s.sheet.x,
      maxHeight: Number.POSITIVE_INFINITY,
      centred: false,
    }),
  );
  return [...slotLabels, ...header];
}

/** Grey gutter and blank fills, then outlines, marks and labels in DeviceGray black. */
export function sideContent(s: ImpositionProofSide): string {
  const blanks = s.slots.filter((slot) => slot.page === "blank").map((slot) => slot.frame);
  const ops = [
    "q",
    ...fillOps(GUTTER_GRAY, s.gutters),
    ...fillOps(BLANK_GRAY, blanks),
    "0 G",
    `${SHEET_LINE_PT} w`,
    rectOp(s.sheet),
    "S",
    `${FRAME_LINE_PT} w`,
    ...s.slots.map((slot) => rectOp(slot.frame)),
    "S",
    "/CropMarks BMC",
    `${MARK_LINE_PT} w`,
    ...pathOps(s.slots.flatMap((slot) => slot.cropMarks)),
    "S",
    "EMC",
    ...foldOps(s),
    "1 J",
    "1 j",
    ...labelOps(s),
    "Q",
  ];
  return `${ops.join("\n")}\n`;
}

/**
 * Renders the proof as a new PDF, one page per sheet side. Deterministic: no
 * dates or ids are written. Throws MarkSpecError on a bad, empty or over-limit
 * plan or bad options.
 */
export async function renderImpositionProof(
  plan: ImpositionProofPlan,
  options: ImpositionProofOptionsInput = {},
): Promise<Uint8Array> {
  const sides = planImpositionProof(plan, options);
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(PROOF_TITLE);
  for (const s of sides) {
    const page = doc.addPage([s.widthPt, s.heightPt]);
    page.node.addContentStream(doc.context.register(doc.context.flateStream(sideContent(s))));
  }
  return doc.save();
}
