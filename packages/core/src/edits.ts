import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Job edits (Spec 007 FR4): per-job geometric and production parameters stored on the
 * ticket and applied in order at layout time. The source PDF is never modified, so
 * removing an edit from the list undoes it.
 *
 * Lengths are millimetres. All geometry math lives in `@bax-print/edits`.
 */

/** Longest length an edit may express: 100 m of roll. */
export const MAX_EDIT_LENGTH_MM = 100_000;
export const MAX_EDIT_BLEED_MM = 100;
export const MAX_EDIT_COPIES = 100_000;
export const MAX_EDITS = 200;
export const MAX_EDIT_METADATA_ENTRIES = 50;
const METADATA_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

const EditId = Type.Optional(Type.String({ minLength: 1, maxLength: 64 }));
const Length = Type.Number({ exclusiveMinimum: 0, maximum: MAX_EDIT_LENGTH_MM });
const Offset = Type.Number({ minimum: 0, maximum: MAX_EDIT_LENGTH_MM });
const ColorantName = Type.String({ minLength: 1, maxLength: 127 });

export const ScaleEditSchema = Type.Object({
  id: EditId,
  kind: Type.Literal("scale"),
  /** Uniform scale in percent of the current size. */
  percent: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100_000 })),
  /** Uniform scale so the current width or height equals the target length. */
  fit: Type.Optional(
    Type.Object({
      dimension: Type.Union([Type.Literal("width"), Type.Literal("height")]),
      targetMm: Length,
    }),
  ),
});

export const RotateEditSchema = Type.Object({
  id: EditId,
  kind: Type.Literal("rotate"),
  /** Clockwise, as viewed (the PDF `/Rotate` convention). */
  degrees: Type.Union([Type.Literal(0), Type.Literal(90), Type.Literal(180), Type.Literal(270)]),
});

export const MirrorEditSchema = Type.Object({
  id: EditId,
  kind: Type.Literal("mirror"),
  /** `horizontal` flips left/right (backlit or reverse-printed film). Default `horizontal`. */
  axis: Type.Optional(Type.Union([Type.Literal("horizontal"), Type.Literal("vertical")])),
});

export const CropEditSchema = Type.Object({
  id: EditId,
  kind: Type.Literal("crop"),
  /** Box in the current artwork frame, origin at its bottom-left corner. */
  box: Type.Object({ xMm: Offset, yMm: Offset, widthMm: Length, heightMm: Length }),
});

export const AddBleedEditSchema = Type.Object({
  id: EditId,
  kind: Type.Literal("addBleed"),
  /** Bleed on each side at final size. 0 removes generated bleed. */
  mm: Type.Number({ minimum: 0, maximum: MAX_EDIT_BLEED_MM }),
  /** `edge` stretches the outermost strip of the artwork; `mirror` reflects the artwork. */
  mode: Type.Union([Type.Literal("edge"), Type.Literal("mirror")]),
});

export const PageSizeEditSchema = Type.Object({
  id: EditId,
  kind: Type.Literal("pageSize"),
  /** Final output size; the artwork (with any bleed) is centred and clipped to it. */
  widthMm: Length,
  heightMm: Length,
});

export const CopiesEditSchema = Type.Object({
  id: EditId,
  kind: Type.Literal("copies"),
  count: Type.Integer({ minimum: 1, maximum: MAX_EDIT_COPIES }),
});

export const SpotTargetSchema = Type.Union([
  Type.Object({ kind: Type.Literal("colorant"), name: ColorantName }),
  Type.Object({ kind: Type.Literal("process") }),
]);

export const SpotMapEditSchema = Type.Object({
  id: EditId,
  kind: Type.Literal("spotMap"),
  /** Exact colorant name as it appears in the PDF. */
  from: ColorantName,
  /** Rename (or merge into) another colorant, or convert to process. */
  to: SpotTargetSchema,
});

export const MetadataEditSchema = Type.Object({
  id: EditId,
  kind: Type.Literal("metadata"),
  /** Free production key/values, e.g. customer, orderNumber, costCentre. */
  values: Type.Record(Type.String(), Type.String({ maxLength: 1000 })),
});

export const JobEditSchema = Type.Union([
  ScaleEditSchema,
  RotateEditSchema,
  MirrorEditSchema,
  CropEditSchema,
  AddBleedEditSchema,
  PageSizeEditSchema,
  CopiesEditSchema,
  SpotMapEditSchema,
  MetadataEditSchema,
]);

export const JobEditListSchema = Type.Array(JobEditSchema, { maxItems: MAX_EDITS });

export type ScaleEdit = Static<typeof ScaleEditSchema>;
export type RotateEdit = Static<typeof RotateEditSchema>;
export type MirrorEdit = Static<typeof MirrorEditSchema>;
export type CropEdit = Static<typeof CropEditSchema>;
export type AddBleedEdit = Static<typeof AddBleedEditSchema>;
export type PageSizeEdit = Static<typeof PageSizeEditSchema>;
export type CopiesEdit = Static<typeof CopiesEditSchema>;
export type SpotTarget = Static<typeof SpotTargetSchema>;
export type SpotMapEdit = Static<typeof SpotMapEditSchema>;
export type MetadataEdit = Static<typeof MetadataEditSchema>;
export type JobEdit = Static<typeof JobEditSchema>;
export type JobEditKind = JobEdit["kind"];

const SCHEMA_BY_KIND: Readonly<Record<JobEditKind, TSchema>> = {
  scale: ScaleEditSchema,
  rotate: RotateEditSchema,
  mirror: MirrorEditSchema,
  crop: CropEditSchema,
  addBleed: AddBleedEditSchema,
  pageSize: PageSizeEditSchema,
  copies: CopiesEditSchema,
  spotMap: SpotMapEditSchema,
  metadata: MetadataEditSchema,
};

export const JOB_EDIT_KINDS = Object.keys(SCHEMA_BY_KIND) as JobEditKind[];

export type EditParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const MAX_ERRORS_PER_EDIT = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEditKind(value: unknown): value is JobEditKind {
  return typeof value === "string" && Object.hasOwn(SCHEMA_BY_KIND, value);
}

function semanticErrors(edit: JobEdit, at: string): string[] {
  switch (edit.kind) {
    case "scale":
      return (edit.percent === undefined) === (edit.fit === undefined)
        ? [`${at}: scale needs exactly one of "percent" or "fit"`]
        : [];
    case "metadata": {
      const keys = Object.keys(edit.values);
      const errors = keys.filter((key) => !METADATA_KEY.test(key)).map((key) => `${at}: invalid metadata key ${JSON.stringify(key)}`);
      if (keys.length > MAX_EDIT_METADATA_ENTRIES) errors.push(`${at}: at most ${MAX_EDIT_METADATA_ENTRIES} metadata entries`);
      return errors;
    }
    case "spotMap":
      return edit.to.kind === "colorant" && edit.to.name === edit.from ? [`${at}: spotMap maps "${edit.from}" to itself`] : [];
    default:
      return [];
  }
}

function editErrors(edit: unknown, index: number): string[] {
  const at = `edits[${index}]`;
  const kind = isRecord(edit) ? edit.kind : undefined;
  if (!isEditKind(kind)) return [`${at}: unknown edit kind ${JSON.stringify(kind)}`];
  const schema = SCHEMA_BY_KIND[kind];
  if (!Value.Check(schema, edit)) {
    return [...Value.Errors(schema, edit)].slice(0, MAX_ERRORS_PER_EDIT).map((e) => `${at}${e.path}: ${e.message}`);
  }
  return semanticErrors(edit as JobEdit, at);
}

/** Validates the shape of an edit list. Geometric validity (e.g. crop bounds) is checked by `@bax-print/edits`. */
export function parseEdits(input: unknown): EditParseResult<JobEdit[]> {
  if (!Array.isArray(input)) return { ok: false, errors: ["edits must be an array"] };
  if (input.length > MAX_EDITS) return { ok: false, errors: [`at most ${MAX_EDITS} edits are allowed`] };
  const errors = input.flatMap((edit, index) => editErrors(edit, index));
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as JobEdit[] };
}
