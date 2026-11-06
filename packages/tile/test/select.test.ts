import { describe, expect, it } from "vitest";
import {
  MAX_PANEL_REF_LENGTH,
  MAX_PANEL_REFS,
  selectPanels,
  tile,
  toNestItems,
  type Panel,
  type PanelSelection,
} from "../src/index.js";

const { panels } = tile({ widthMm: 3000, heightMm: 2000 }, { grid: { mode: "count", columns: 3, rows: 2 } });

function selected(result: PanelSelection): Panel[] {
  if (!result.ok) throw new Error(`expected a selection, got ${JSON.stringify(result.issues)}`);
  return result.panels;
}

const codes = (result: PanelSelection): string[] => (result.ok ? [] : result.issues.map((i) => i.code));

describe("FR7 selecting panels to reprint", () => {
  it("reprints panel B3 alone by its label, keeping the recorded item id", () => {
    const chosen = selected(selectPanels(panels, ["B3"]));

    expect(chosen.map((p) => p.id)).toEqual(["2-3"]);
    const items = toNestItems(chosen, { jobId: "job-7", pageIndex: 0, trimOriginPt: { x: 0, y: 0 } });
    expect(items.map((i) => i.id)).toEqual(["job-7/panel/2-3"]);
  });

  it("resolves ids, item ids and labels; dedupes; returns panels in hanging order", () => {
    const chosen = selected(selectPanels(panels, ["B2", "1-3", "job-7/panel/2-2", "panel/1-1", "A3"], { jobId: "job-7" }));
    expect(chosen.map((p) => p.id)).toEqual(["1-1", "1-3", "2-2"]);
  });

  it("round-trips the item ids Spec 008 records", () => {
    const recorded = toNestItems(panels, { jobId: "job-7", pageIndex: 0, trimOriginPt: { x: 0, y: 0 } }).map((i) => i.id);
    expect(selected(selectPanels(panels, recorded, { jobId: "job-7" }))).toEqual(panels);
  });

  it("rejects item ids of another job, or job ids when no job is given", () => {
    expect(codes(selectPanels(panels, ["job-8/panel/1-1"], { jobId: "job-7" }))).toEqual(["unknown-panel"]);
    expect(codes(selectPanels(panels, ["job-7/panel/1-1"]))).toEqual(["unknown-panel"]);
  });

  it("fails the whole selection on unknown references, one issue each", () => {
    const result = selectPanels(panels, ["A1", "D1", "3-1", "b3"]);
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["unknown-panel", "unknown-panel", "unknown-panel"]);
  });

  it("flags a label two panels share instead of guessing", () => {
    // With no separator, row 1 col 11 and row 11 col 1 are both "111".
    const grid = tile(
      { widthMm: 1100, heightMm: 1100 },
      { grid: { mode: "count", columns: 11, rows: 11 }, seam: { kind: "butt" }, naming: { rows: "numbers", cols: "numbers", separator: "" } },
    );
    const result = selectPanels(grid.panels, ["111"]);

    expect(codes(result)).toEqual(["ambiguous-panel-ref"]);
    expect(result.ok ? [] : result.issues.map((i) => i.message)).toEqual(['panel reference "111" matches panels 1-11, 11-1']);
    // The id is still unique.
    expect(selected(selectPanels(grid.panels, ["11-1"])).map((p) => p.label)).toEqual(["111"]);
  });

  it("rejects empty, malformed, overlong and oversized requests without throwing", () => {
    expect(codes(selectPanels(panels, []))).toEqual(["invalid-panel-ref"]);
    expect(codes(selectPanels(panels, ["", 42, null, "x".repeat(MAX_PANEL_REF_LENGTH + 1)]))).toEqual([
      "invalid-panel-ref",
      "invalid-panel-ref",
      "invalid-panel-ref",
      "invalid-panel-ref",
    ]);
    expect(codes(selectPanels(panels, Array.from({ length: MAX_PANEL_REFS + 1 }, () => "A1")))).toEqual(["invalid-panel-ref"]);
  });

  it("does not change the input panels or their order", () => {
    const before = structuredClone(panels);
    selectPanels(panels, ["B3", "A1"]);
    expect(panels).toEqual(before);
  });
});
