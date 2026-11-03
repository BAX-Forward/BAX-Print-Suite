/**
 * Resolves a finishing spec against a Spec 003 layout: validates the input,
 * plans every mark and label per placement, maps them into the layout frame,
 * warns when they run off the medium, and rejects collisions with the Spec 004
 * registration marks before anything is rendered.
 */
import { assertNoCollisions } from "./collision.js";
import { MarkSpecError } from "./errors.js";
import { itemMatrix, type ItemBox } from "./geometry.js";
import { assignMarkIds, planItemLocal } from "./item-plan.js";
import type { Layout, Placement, RegistrationInput, RollMedia } from "./layout-types.js";
import { elementBounds, transformPart } from "./parts.js";
import type { FinishingPlan, ItemInfo, JobInfo, PlannedElement } from "./plan-types.js";
import { FinishingSpecSchema, formatIssues, type FinishingSpec, type FinishingSpecInput } from "./schema.js";
import { prepareSymbols, type SymbolSource, type SymbolTable } from "./symbols.js";
import { mmToPt, ptToMm } from "./units.js";

/** Footprints may differ from item + bleed by this much before we warn. */
const FOOTPRINT_TOLERANCE_PT = 0.5;
const MEDIUM_TOLERANCE_MM = 1e-6;

export interface PlanInput {
  readonly layout: Pick<Layout, "placements">;
  readonly items: readonly ItemInfo[];
  readonly finishing: FinishingSpecInput;
  readonly job: JobInfo;
  /** Spec 004 registration marks of the same layout, for the collision check. */
  readonly registration?: RegistrationInput;
  /** When given, elements that run off the medium produce warnings. */
  readonly media?: RollMedia;
  /** Custom mark symbols by `symbolId`. */
  readonly symbols?: Readonly<Record<string, SymbolSource>>;
}

export function parseFinishing(input: FinishingSpecInput): FinishingSpec {
  const parsed = FinishingSpecSchema.safeParse(input);
  if (!parsed.success) throw new MarkSpecError("invalid finishing spec", formatIssues(parsed.error));
  return parsed.data;
}

export function itemBox(item: ItemInfo): ItemBox {
  return { widthMm: item.widthMm, heightMm: item.heightMm, bleedMm: item.bleedMm ?? 0 };
}

function validateItems(items: readonly ItemInfo[]): Map<string, ItemInfo> {
  const byId = new Map<string, ItemInfo>();
  const issues: string[] = [];
  for (const item of items) {
    if (byId.has(item.itemId)) issues.push(`duplicate item "${item.itemId}"`);
    if (!(item.widthMm > 0 && item.heightMm > 0)) issues.push(`item "${item.itemId}" needs a positive trim size`);
    if ((item.bleedMm ?? 0) < 0) issues.push(`item "${item.itemId}" has a negative bleed`);
    byId.set(item.itemId, item);
  }
  if (issues.length > 0) throw new MarkSpecError("invalid items", issues);
  return byId;
}

function validatePlacements(placements: readonly Placement[], items: Map<string, ItemInfo>): void {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const p of placements) {
    const key = `${p.itemId}#${p.copy}`;
    if (!items.has(p.itemId)) issues.push(`placement ${key} refers to unknown item "${p.itemId}"`);
    if (seen.has(key)) issues.push(`placement ${key} appears twice`);
    seen.add(key);
  }
  if (issues.length > 0) throw new MarkSpecError("invalid layout", issues);
}

function footprintWarning(p: Placement, box: ItemBox): string | undefined {
  const w = mmToPt(box.widthMm + 2 * box.bleedMm);
  const h = mmToPt(box.heightMm + 2 * box.bleedMm);
  const [ew, eh] = p.rotation === 90 || p.rotation === 270 ? [h, w] : [w, h];
  if (Math.abs(p.footprint.w - ew) <= FOOTPRINT_TOLERANCE_PT && Math.abs(p.footprint.h - eh) <= FOOTPRINT_TOLERANCE_PT) {
    return undefined;
  }
  return `placement ${p.itemId}#${p.copy}: footprint ${p.footprint.w.toFixed(1)} x ${p.footprint.h.toFixed(1)} pt does not match the item size plus bleed`;
}

function mediumWarnings(elements: readonly PlannedElement[], media: RollMedia): string[] {
  const minX = -ptToMm(media.margins.left);
  const maxX = ptToMm(media.widthPt - media.margins.left);
  const minY = -ptToMm(media.margins.lead);
  const warnings: string[] = [];
  for (const el of elements) {
    const b = elementBounds(el);
    if (!b) continue;
    const over = Math.max(minX - b.x, b.x + b.w - maxX);
    if (over > MEDIUM_TOLERANCE_MM) {
      warnings.push(
        `${el.id} extends ${over.toFixed(2)} mm past the side of the medium; the medium is too narrow for this ${el.kind === "label" ? "label" : "mark"}`,
      );
    }
    if (minY - b.y > MEDIUM_TOLERANCE_MM) {
      warnings.push(`${el.id} starts ${(minY - b.y).toFixed(2)} mm before the lead edge of the medium`);
    }
  }
  return warnings;
}

function copyTotals(placements: readonly Placement[], items: Map<string, ItemInfo>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of placements) counts.set(p.itemId, (counts.get(p.itemId) ?? 0) + 1);
  for (const [id, item] of items) if (item.copies !== undefined) counts.set(id, item.copies);
  return counts;
}

function neededSymbols(finishing: FinishingSpec): string[] {
  return finishing.marks.flatMap((m) => (m.kind === "custom" ? [m.symbolId] : []));
}

export async function loadSymbols(
  finishing: FinishingSpec,
  sources: PlanInput["symbols"],
): Promise<{ table: SymbolTable; warnings: string[] }> {
  return prepareSymbols(sources, neededSymbols(finishing));
}

/**
 * Plans all finishing elements. Throws `MarkSpecError` for invalid input and
 * `MarkCollisionError` when an element enters a registration clearance zone.
 * Pure: the same input always yields the same geometry.
 */
export async function planFinishing(input: PlanInput): Promise<FinishingPlan> {
  if (!input.job.id) throw new MarkSpecError("job.id is required");
  const finishing = parseFinishing(input.finishing);
  const items = validateItems(input.items);
  const placements = input.layout.placements;
  validatePlacements(placements, items);
  const markIds = assignMarkIds(finishing.marks);
  const { table: symbols, warnings } = await loadSymbols(finishing, input.symbols);
  const totals = copyTotals(placements, items);

  const elements: PlannedElement[] = [];
  for (const p of placements) {
    const item = items.get(p.itemId)!;
    const box = itemBox(item);
    const fw = footprintWarning(p, box);
    if (fw) warnings.push(fw);
    const local = planItemLocal(
      finishing,
      markIds,
      { item: box, copy: p.copy, copyTotal: totals.get(p.itemId) ?? 1, panel: item.panel, job: input.job },
      symbols,
    );
    warnings.push(...local.warnings.map((w) => `${p.itemId}: ${w}`));
    const m = itemMatrix(ptToMm(p.xPt), ptToMm(p.yPt), p.rotation, box);
    for (const el of local.elements) {
      elements.push({
        id: `${p.itemId}#${p.copy}/${el.markId}`,
        itemId: p.itemId,
        copy: p.copy,
        markId: el.markId,
        kind: el.kind,
        parts: el.parts.map((part) => transformPart(part, m)),
      });
    }
  }
  if (input.media) warnings.push(...mediumWarnings(elements, input.media));
  assertNoCollisions(elements, input.registration);

  return {
    version: 1,
    colorant: finishing.colorant,
    elements,
    symbols,
    warnings: [...new Set(warnings)],
  };
}
