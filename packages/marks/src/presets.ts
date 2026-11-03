/**
 * Mark presets (Spec 006 FR6): JSON objects applied per hot folder or queue,
 * overridable per job (`JobTicket.finishing`, edited in Spec 007) and exportable.
 */
import { MarkSpecError } from "./errors.js";
import { assignMarkIds } from "./item-plan.js";
import {
  FinishingOverrideSchema,
  FinishingSpecSchema,
  MarkPresetSchema,
  formatIssues,
  type FinishingOverride,
  type FinishingSpec,
  type MarkPreset,
  type MarkSpec,
} from "./schema.js";

export function parsePreset(input: unknown): MarkPreset {
  const parsed = MarkPresetSchema.safeParse(input);
  if (!parsed.success) throw new MarkSpecError("invalid mark preset", formatIssues(parsed.error));
  return parsed.data;
}

/** Parses an exported preset file (a single preset or an array). */
export function importPresets(json: string): MarkPreset[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    throw new MarkSpecError("mark preset file is not valid JSON", [String(err)]);
  }
  const list = Array.isArray(value) ? value : [value];
  const presets = list.map(parsePreset);
  const ids = presets.map((p) => p.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) throw new MarkSpecError("duplicate preset ids", [...new Set(duplicates)]);
  return presets;
}

/** Pretty JSON with every default spelled out, so the file is self-describing. */
export function exportPresets(presets: MarkPreset | readonly MarkPreset[]): string {
  const many = Array.isArray(presets);
  const list: readonly unknown[] = many ? presets : [presets];
  const parsed = list.map(parsePreset);
  return `${JSON.stringify(many ? parsed : parsed[0], null, 2)}\n`;
}

export interface PresetLookup {
  readonly presets: readonly MarkPreset[];
  readonly hotFolderId?: string;
  readonly queueId?: string;
  /** Per-job override; its `presetId` wins over hot-folder and queue defaults. */
  readonly override?: FinishingOverride;
}

/** Explicit `presetId`, else the hot folder's preset, else the queue's. */
export function selectPreset(lookup: PresetLookup): MarkPreset | undefined {
  const { presets, override } = lookup;
  if (override?.presetId !== undefined) {
    const p = presets.find((x) => x.id === override.presetId);
    if (!p) throw new MarkSpecError(`unknown mark preset "${override.presetId}"`);
    return p;
  }
  const { hotFolderId, queueId } = lookup;
  return (
    (hotFolderId !== undefined ? presets.find((p) => p.appliesTo.hotFolders.includes(hotFolderId)) : undefined) ??
    (queueId !== undefined ? presets.find((p) => p.appliesTo.queues.includes(queueId)) : undefined)
  );
}

type OverrideMark = { kind: string; id?: string } & Record<string, unknown>;

function mergeMarks(base: readonly MarkSpec[], overrides: readonly OverrideMark[], remove: readonly string[]): unknown[] {
  const ids = assignMarkIds(base);
  const merged: { id: string; mark: Record<string, unknown> }[] = base.map((m, i) => ({ id: ids[i]!, mark: { ...m } }));
  for (const o of overrides) {
    const target =
      o.id !== undefined ? merged.find((m) => m.id === o.id) : merged.find((m) => m.mark.kind === o.kind);
    if (target) target.mark = target.mark.kind === o.kind ? { ...target.mark, ...o } : { ...o };
    else merged.push({ id: o.id ?? o.kind, mark: { ...o } });
  }
  return merged.filter((m) => !remove.includes(m.id) && !remove.includes(String(m.mark.kind))).map((m) => m.mark);
}

function mergeLabel(base: FinishingSpec["label"], override: Record<string, unknown> | null | undefined): unknown {
  if (override === null) return undefined;
  if (override === undefined) return base;
  const code =
    override.code !== null && typeof override.code === "object"
      ? { ...(base?.code ?? {}), ...(override.code as Record<string, unknown>) }
      : (base?.code ?? override.code);
  return { ...(base ?? {}), ...override, ...(code !== undefined ? { code } : {}) };
}

/**
 * The finishing spec for a job: the selected preset (or an empty spec) with
 * the job's override applied. Marks merge by id, else by kind; unmatched
 * override marks are appended.
 */
export function resolveFinishing(lookup: PresetLookup): FinishingSpec {
  const parsedOverride = FinishingOverrideSchema.safeParse(lookup.override ?? {});
  if (!parsedOverride.success) throw new MarkSpecError("invalid finishing override", formatIssues(parsedOverride.error));
  const override = parsedOverride.data;
  const base = selectPreset(lookup)?.finishing ?? FinishingSpecSchema.parse({});
  const candidate = {
    colorant: override.colorant ?? base.colorant,
    marks: mergeMarks(base.marks, override.marks as OverrideMark[], override.removeMarks),
    label: mergeLabel(base.label, override.label),
  };
  const result = FinishingSpecSchema.safeParse(candidate);
  if (!result.success) throw new MarkSpecError("finishing override produces an invalid spec", formatIssues(result.error));
  return result.data;
}
