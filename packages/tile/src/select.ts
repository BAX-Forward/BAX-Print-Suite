/**
 * FR7: pick panels to print or reprint by the names an operator or a job
 * record uses ("reprint panel B3 alone after it's damaged").
 *
 * A reference is a panel id (`2-3`), a nest item id (`panel/2-3`, or
 * `<jobId>/panel/2-3` when `jobId` is given; Spec 008 records these), or a
 * label (`B3`). Matching is exact. The selection feeds `panelPdf()` or
 * `toNestItems()` unchanged.
 */
import { MAX_PANELS_PER_AXIS } from "./axis.js";
import { panelItemId } from "./nest-item.js";
import type { Panel, TileIssue } from "./types.js";

/** One reference per panel of the largest grid. */
export const MAX_PANEL_REFS = MAX_PANELS_PER_AXIS * MAX_PANELS_PER_AXIS;

/** Longer than any id or label a grid produces, with room for a job id prefix. */
export const MAX_PANEL_REF_LENGTH = 256;

export interface SelectPanelsOptions {
  /** Job the panels belong to; enables `<jobId>/panel/<row>-<col>` references. */
  jobId?: string;
}

export type PanelSelection = { ok: true; panels: Panel[] } | { ok: false; issues: TileIssue[] };

/**
 * Resolve references to panels. Duplicates collapse; the result is in panel
 * index order (row-major, the hanging order) whatever the request order.
 * Never throws on user input: an unknown, ambiguous or malformed reference
 * fails the whole selection with one issue per bad reference.
 */
export function selectPanels(
  panels: readonly Panel[],
  refs: readonly unknown[],
  options: SelectPanelsOptions = {},
): PanelSelection {
  if (refs.length === 0) return invalid("select at least one panel");
  if (refs.length > MAX_PANEL_REFS) return invalid(`at most ${MAX_PANEL_REFS} panel references`);

  const byName = nameIndex(panels, options.jobId);
  const issues: TileIssue[] = [];
  const chosen = new Set<Panel>();
  refs.forEach((ref, i) => {
    if (typeof ref !== "string" || ref === "" || ref.length > MAX_PANEL_REF_LENGTH) {
      issues.push({
        code: "invalid-panel-ref",
        message: `panel reference ${i} must be a non-empty string of at most ${MAX_PANEL_REF_LENGTH} characters`,
      });
      return;
    }
    const matches = byName.get(ref) ?? [];
    const [only] = matches;
    if (matches.length > 1) {
      issues.push({
        code: "ambiguous-panel-ref",
        message: `panel reference "${ref}" matches panels ${matches.map((p) => p.id).join(", ")}`,
      });
    } else if (only) {
      chosen.add(only);
    } else {
      issues.push({ code: "unknown-panel", message: `no panel "${ref}" in this tiling` });
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, panels: [...chosen].sort((a, b) => a.index - b.index) };
}

function invalid(message: string): PanelSelection {
  return { ok: false, issues: [{ code: "invalid-panel-ref", message }] };
}

/** Every name a panel answers to, mapped to the distinct panels that answer to it. */
function nameIndex(panels: readonly Panel[], jobId: string | undefined): Map<string, Panel[]> {
  const index = new Map<string, Panel[]>();
  for (const panel of panels) {
    const names = new Set([panel.id, panelItemId(panel.id), panel.label]);
    if (jobId !== undefined) names.add(panelItemId(panel.id, jobId));
    for (const name of names) {
      const list = index.get(name);
      if (list) list.push(panel);
      else index.set(name, [panel]);
    }
  }
  return index;
}
