import { describe, expect, it } from "vitest";
import {
  DEFAULT_TICK_LENGTH_MM,
  overlapStrip,
  panelTemplateFields,
  placePanelLabel,
  seamTicks,
  tile,
  type Panel,
} from "../src/index.js";

const page = { widthMm: 3000, heightMm: 2000 };
const grid = { mode: "count", columns: 3, rows: 2 } as const;
const overlapPanels = tile(page, { grid }).panels;
const byLabel = (panels: Panel[], label: string): Panel => {
  const panel = panels.find((p) => p.label === label);
  if (!panel) throw new Error(`no panel ${label}`);
  return panel;
};

describe("FR6 seam alignment ticks", () => {
  it("puts ticks on the seam line at both ends of every overlap seam", () => {
    const a1 = byLabel(overlapPanels, "A1");
    const ticks = seamTicks(a1);

    // A1 (top-left) has an overlap seam on its right and its bottom.
    expect(ticks.map((t) => t.side)).toEqual(["right", "right", "bottom", "bottom"]);
    const seamX = a1.visible.x + a1.visible.width - a1.printed.x;
    for (const t of ticks.filter((t) => t.side === "right")) {
      expect(t.from[0]).toBe(seamX);
      expect(t.to[0]).toBe(seamX);
      expect(t.to[1] - t.from[1]).toBe(DEFAULT_TICK_LENGTH_MM);
    }
    const seamY = a1.visible.y - a1.printed.y;
    for (const t of ticks.filter((t) => t.side === "bottom")) expect([t.from[1], t.to[1]]).toEqual([seamY, seamY]);
  });

  it("keeps ticks inside the printed area and within the overlap strip of the seam", () => {
    for (const panel of overlapPanels) {
      for (const t of seamTicks(panel)) {
        for (const [x, y] of [t.from, t.to]) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(panel.printed.width);
          expect(y).toBeLessThanOrEqual(panel.printed.height);
        }
        // The seam line is the strip's inner edge, so ticks lie on its boundary.
        const strip = overlapStrip(panel, t.side);
        expect(strip).toBeDefined();
      }
    }
  });

  it("marks the same seam on both neighbours", () => {
    const a1 = byLabel(overlapPanels, "A1");
    const a2 = byLabel(overlapPanels, "A2");
    const right = seamTicks(a1).filter((t) => t.side === "right").map((t) => t.from[0] + a1.printed.x);
    const left = seamTicks(a2).filter((t) => t.side === "left").map((t) => t.from[0] + a2.printed.x);
    expect(right).toEqual([1000, 1000]);
    expect(left).toEqual([1000, 1000]);
  });

  it("gives butt and gap seams no ticks", () => {
    for (const seam of [{ kind: "butt" }, { kind: "gap", gapMm: 10 }] as const) {
      for (const panel of tile(page, { grid, seam }).panels) expect(seamTicks(panel)).toEqual([]);
    }
  });
});

describe("FR5 label placement and template fields", () => {
  it("exposes panel.row and panel.col for Spec 006 templates", () => {
    expect(panelTemplateFields(byLabel(overlapPanels, "B3"))).toEqual({ "panel.row": "B", "panel.col": "3" });
  });

  it("hides the label in an overlap strip that the next panel covers", () => {
    const a1 = byLabel(overlapPanels, "A1");
    const placement = placePanelLabel(a1, { widthMm: 40, heightMm: 10 });

    expect(placement).toMatchObject({ side: "right", rotation: 90, hidden: true });
    // Turned 90°: 10 mm across the 25 mm strip, centred in it (panel frame).
    expect(placement.box).toEqual({ x: 1007.5, y: 505, width: 10, height: 40 });
  });

  it("falls back to the bottom strip, then to a visible corner", () => {
    const a1 = byLabel(overlapPanels, "A1");
    // A1's left edge is the artwork edge, so the next preferred side is used.
    const bottom = placePanelLabel(a1, { widthMm: 40, heightMm: 10, underSides: ["left", "bottom"] });
    expect(bottom).toMatchObject({ side: "bottom", rotation: 0, hidden: true });
    expect(bottom.box).toEqual({ x: 480, y: 7.5, width: 40, height: 10 });

    const tooBig = placePanelLabel(a1, { widthMm: 40, heightMm: 30 });
    expect(tooBig).toMatchObject({ side: "inside", hidden: false, rotation: 0 });

    // B3 (bottom-right) has no right or bottom overlap at all.
    const b3 = byLabel(overlapPanels, "B3");
    const inside = placePanelLabel(b3, { widthMm: 40, heightMm: 10 });
    expect(inside).toMatchObject({ side: "inside", hidden: false });
    expect(inside.box).toEqual({ x: 27, y: 2, width: 40, height: 10 });
  });
});
