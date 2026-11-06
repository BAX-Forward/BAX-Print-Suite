/**
 * MarkSpec, LabelSpec, FinishingSpec and MarkPreset schemas (Spec 006 FR1–FR6).
 * All lengths are millimetres unless the field name says otherwise.
 * These types are the intended content of `JobTicket.finishing` in packages/core.
 */
import { z } from "zod";

export const EDGES = ["top", "bottom", "left", "right"] as const;
export const EdgeSchema = z.enum(EDGES);
export type Edge = z.infer<typeof EdgeSchema>;

export const ANCHORS = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;
export const AnchorSchema = z.enum(ANCHORS);
export type Anchor = z.infer<typeof AnchorSchema>;

/** `separation` = Separation /BPS-Marks (alternate 100 % K); `registration` = /All; `process-k` = DeviceCMYK K. */
export const COLORANTS = ["separation", "registration", "process-k"] as const;
export const ColorantSchema = z.enum(COLORANTS);
export type Colorant = z.infer<typeof ColorantSchema>;

export const MARK_KINDS = ["crop", "trim-line", "grommet", "hem-line", "sew-line", "fold-line", "custom"] as const;
export const MarkKindSchema = z.enum(MARK_KINDS);
export type MarkKind = z.infer<typeof MarkKindSchema>;

const markId = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, "mark id: 1-64 of A-Z a-z 0-9 . _ -")
  .optional();
const edgeList = () => z.array(EdgeSchema).min(1).default([...EDGES]);
const lineWidthPt = (fallback: number) => z.number().positive().max(10).default(fallback);
const dashMm = (on: number, off: number) =>
  z.tuple([z.number().positive(), z.number().positive()]).default([on, off]);

export const CropMarkSchema = z.object({
  kind: z.literal("crop"),
  id: markId,
  lengthMm: z.number().positive().max(100).default(6),
  /** Distance from the trim; raised to the bleed when smaller, so marks never land in the bleed. */
  offsetMm: z.number().min(0).max(100).default(3),
  lineWidthPt: lineWidthPt(0.25),
  /**
   * Also draw bleed marks (Spec 046b): corner lines on the bleed box edge
   * extensions, `offsetMm` beyond the bleed box. Opt-in; absent = off, and the
   * output is unchanged. Not drawn when the item has no bleed (they would
   * coincide with the crop marks).
   */
  bleedMarks: z.boolean().optional(),
});

export const TrimLineSchema = z.object({
  kind: z.literal("trim-line"),
  id: markId,
  lineWidthPt: lineWidthPt(0.1),
});

export const GrommetSchema = z.object({
  kind: z.literal("grommet"),
  id: markId,
  insetMm: z.number().min(0).default(25),
  spacingMm: z.number().positive().default(600),
  diameterMm: z.number().positive().max(100).default(5),
  style: z.enum(["dot", "crosshair"]).default("dot"),
  edges: edgeList(),
  lineWidthPt: lineWidthPt(0.5),
});

function edgeLineSchema<K extends "hem-line" | "sew-line">(kind: K, offsetMm: number, on: number, off: number) {
  return z.object({
    kind: z.literal(kind),
    id: markId,
    edges: edgeList(),
    /** Positive = inside the trim, negative = outside. */
    offsetMm: z.number().default(offsetMm),
    dashMm: dashMm(on, off),
    lineWidthPt: lineWidthPt(0.5),
  });
}

export const HemLineSchema = edgeLineSchema("hem-line", 30, 6, 3);
export const SewLineSchema = edgeLineSchema("sew-line", 15, 2, 2);

export const FoldLineSchema = z.object({
  kind: z.literal("fold-line"),
  id: markId,
  /** `vertical`: positionMm from the left trim edge; `horizontal`: from the bottom trim edge. */
  axis: z.enum(["vertical", "horizontal"]).default("vertical"),
  positionMm: z.number(),
  dashMm: dashMm(4, 2),
  lineWidthPt: lineWidthPt(0.5),
  ticks: z.boolean().default(true),
  tickLengthMm: z.number().positive().max(100).default(6),
  tickOffsetMm: z.number().min(0).max(100).default(3),
  tickLineWidthPt: lineWidthPt(0.25),
});

export const CustomMarkSchema = z.object({
  kind: z.literal("custom"),
  id: markId,
  /** Key into the symbol sources passed to `draw()` (single-page PDF or SVG). */
  symbolId: z.string().min(1).max(128),
  widthMm: z.number().positive().max(1000),
  /** Defaults to widthMm × the symbol's aspect ratio. */
  heightMm: z.number().positive().max(1000).optional(),
  anchors: z.array(AnchorSchema).min(1).optional(),
  repeat: z
    .object({
      edges: edgeList(),
      intervalMm: z.number().positive(),
      /** Distance from the trim edge into the artwork, and from the corners along the edge. */
      insetMm: z.number().default(0),
    })
    .optional(),
  /** Offset from each anchor in the item frame. */
  offsetMm: z.tuple([z.number(), z.number()]).default([0, 0]),
});

export const MarkSpecSchema = z
  .discriminatedUnion("kind", [
    CropMarkSchema,
    TrimLineSchema,
    GrommetSchema,
    HemLineSchema,
    SewLineSchema,
    FoldLineSchema,
    CustomMarkSchema,
  ])
  .superRefine((mark, ctx) => {
    if (mark.kind === "custom" && (mark.anchors === undefined) === (mark.repeat === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "custom mark needs exactly one of anchors or repeat" });
    }
  });

export type CropMark = z.output<typeof CropMarkSchema>;
export type TrimLine = z.output<typeof TrimLineSchema>;
export type GrommetMark = z.output<typeof GrommetSchema>;
export type HemLine = z.output<typeof HemLineSchema>;
export type SewLine = z.output<typeof SewLineSchema>;
export type FoldLine = z.output<typeof FoldLineSchema>;
export type CustomMark = z.output<typeof CustomMarkSchema>;
export type MarkSpec = z.output<typeof MarkSpecSchema>;
export type MarkSpecInput = z.input<typeof MarkSpecSchema>;

export const CodeSpecSchema = z
  .object({
    enabled: z.boolean().default(true),
    symbology: z.enum(["qr", "datamatrix"]).default("qr"),
    /** `uri` = bps:job/<jobId>[/panel/<r>-<c>]; `url` = <baseUrl>/jobs/<jobId>[?panel=<r>-<c>]. */
    payload: z.enum(["uri", "url"]).default("uri"),
    baseUrl: z
      .string()
      .url()
      .refine((u) => u.startsWith("https://"), "baseUrl must be an https URL")
      .optional(),
    /** ≥ 0.5 mm so phone cameras and fixed scanners read it from a normal distance. */
    moduleMm: z.number().min(0.5).max(5).default(0.5),
    /** Default 4 for QR (ISO/IEC 18004), 2 for Data Matrix (ISO/IEC 16022 minimum is 1). */
    quietZoneModules: z.number().int().min(1).max(10).optional(),
    position: z.enum(["before", "after"]).default("before"),
  })
  .superRefine((code, ctx) => {
    if (code.payload === "url" && code.baseUrl === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baseUrl"], message: 'payload "url" requires baseUrl' });
    }
  });

export type CodeSpec = z.output<typeof CodeSpecSchema>;

export const DEFAULT_LABEL_TEMPLATE =
  "{{job.name}}  {{job.customer}}\n" +
  "{{item.widthMm|mm}} x {{item.heightMm|mm}}  copy {{copy.index}}/{{copy.total}}\n" +
  "{{job.id}}  {{date}}";

export const LabelSpecSchema = z.object({
  enabled: z.boolean().default(true),
  edge: EdgeSchema.default("bottom"),
  /** Gap between the bleed box and the label. */
  marginMm: z.number().min(0).max(200).default(3),
  align: z.enum(["start", "center", "end"]).default("start"),
  template: z.string().max(2000).default(DEFAULT_LABEL_TEMPLATE),
  fontSizePt: z.number().min(4).max(72).default(8),
  /** Gap between the code and the text block. */
  gapMm: z.number().min(0).max(50).default(2),
  code: CodeSpecSchema.default({}),
});

export type LabelSpec = z.output<typeof LabelSpecSchema>;
export type LabelSpecInput = z.input<typeof LabelSpecSchema>;

export const FinishingSpecSchema = z.object({
  colorant: ColorantSchema.default("separation"),
  marks: z.array(MarkSpecSchema).default([]),
  label: LabelSpecSchema.optional(),
});

export type FinishingSpec = z.output<typeof FinishingSpecSchema>;
export type FinishingSpecInput = z.input<typeof FinishingSpecSchema>;

/**
 * Per-job override of a preset (Spec 007 editor). Marks merge by `id`, else by
 * `kind`; `removeMarks` drops marks by id or kind; `label: null` removes the label.
 * This is the shape stored in `JobTicket.finishing`.
 */
export const FinishingOverrideSchema = z.object({
  presetId: z.string().min(1).optional(),
  colorant: ColorantSchema.optional(),
  marks: z.array(z.object({ kind: MarkKindSchema, id: markId }).passthrough()).default([]),
  removeMarks: z.array(z.string()).default([]),
  label: z.union([z.null(), z.record(z.unknown())]).optional(),
});

export type FinishingOverride = z.input<typeof FinishingOverrideSchema>;
export type JobTicketFinishing = FinishingOverride;

export const MarkPresetSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "preset id: 1-64 of A-Z a-z 0-9 . _ -"),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  version: z.literal(1).default(1),
  /** Hot folders and queues that apply this preset by default. */
  appliesTo: z
    .object({
      hotFolders: z.array(z.string()).default([]),
      queues: z.array(z.string()).default([]),
    })
    .default({}),
  finishing: FinishingSpecSchema,
});

export type MarkPreset = z.output<typeof MarkPresetSchema>;
export type MarkPresetInput = z.input<typeof MarkPresetSchema>;

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`);
}
