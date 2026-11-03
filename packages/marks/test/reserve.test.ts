import { describe, expect, it } from "vitest";
import {
  itemReservations,
  layoutReservation,
  mmToPt,
  planFinishing,
  reserveSpace,
  rotateEdge,
  type Edge,
  type FinishingSpecInput,
  type ItemInfo,
} from "../src/index.js";
import { placeMm } from "./helpers.js";

const ITEM: ItemInfo = { itemId: "a", widthMm: 400, heightMm: 200, bleedMm: 3 };
const JOB = { id: "J-R", date: "2026-01-01" };
/**
 * Crop marks reach 3 + 6 = 9 mm from the trim, 6 mm past the bleed. The
 * code-only label (bps:job/J-R: 21 modules + 2 × 4 quiet zone, 0.5 mm = 14.5 mm)
 * starts max(bleed 3, crop 9) + 3 = 12 mm below the trim: 26.5 − 3 = 23.5 mm past the bleed.
 */
const FINISHING: FinishingSpecInput = { marks: [{ kind: "crop" }], label: { edge: "bottom", template: "" } };

describe("margin reservation (FR4, Spec 003 reserve(edge, mm))", () => {
  it("rotates item edges counter-clockwise into layout edges", () => {
    expect(rotateEdge("bottom", 0)).toBe("bottom");
    expect(rotateEdge("bottom", 90)).toBe("right");
    expect(rotateEdge("bottom", 180)).toBe("top");
    expect(rotateEdge("bottom", 270)).toBe("left");
    expect(rotateEdge("left", 90)).toBe("bottom");
  });

  it("measures how far each item's marks and label reach past its bleed box", async () => {
    const space = (await itemReservations({ items: [ITEM], finishing: FINISHING, job: JOB })).get("a")!;
    expect(space.left).toBeCloseTo(6, 9);
    expect(space.right).toBeCloseTo(6, 9);
    expect(space.top).toBeCloseTo(6, 9);
    expect(space.bottom).toBeCloseTo(23.5, 9);
  });

  it("reserves nothing for marks that stay inside the bleed box", async () => {
    const space = await layoutReservation({ items: [ITEM], finishing: { marks: [{ kind: "grommet" }, { kind: "hem-line" }] }, job: JOB });
    expect(space).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it("takes the maximum over the rotations the nester may use", async () => {
    const space = await layoutReservation({ items: [ITEM], finishing: FINISHING, job: JOB, rotations: [0, 90] });
    expect(space.bottom).toBeCloseTo(23.5, 9);
    expect(space.right).toBeCloseTo(23.5, 9);
    expect(space.top).toBeCloseTo(6, 9);
    expect(space.left).toBeCloseTo(6, 9);
  });

  it("hands every non-zero edge to the Spec 003 reserver", async () => {
    const calls: [Edge, number][] = [];
    await reserveSpace({ items: [ITEM], finishing: { label: { edge: "top", template: "" } }, job: JOB }, {
      reserve: (edge, mm) => calls.push([edge, mm]),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("top");
    expect(calls[0]![1]).toBeCloseTo(3 + 14.5, 9);
  });

  it("warns when the medium is too narrow for the label", async () => {
    const input = (widthMm: number) =>
      planFinishing({
        layout: { placements: [placeMm(ITEM, 10, 10)] },
        items: [ITEM],
        job: JOB,
        finishing: { label: { edge: "right", template: "" } },
        media: { widthPt: mmToPt(widthMm), margins: { left: 0, right: 0, lead: 0, trail: 0 } },
      });
    // Trim right edge at 10 + 3 + 400 = 413; label from 413 + 3 + 3 to 433.5.
    const narrow = await input(420);
    expect(narrow.warnings.some((w) => w.includes("a#0/label") && w.includes("too narrow"))).toBe(true);
    const wide = await input(440);
    expect(wide.warnings).toEqual([]);
  });
});
