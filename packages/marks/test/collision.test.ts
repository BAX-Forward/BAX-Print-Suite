import { PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REGISTRATION_CLEARANCE_MM,
  MarkCollisionError,
  draw,
  mmToPt,
  planFinishing,
  readLayoutMetadata,
  registrationZones,
  type Edge,
  type ItemInfo,
  type RegistrationInput,
} from "../src/index.js";
import { placeMm } from "./helpers.js";
import { hookContext, imposeFixture, pageContent } from "./pdf-helpers.js";

const ITEM: ItemInfo = { itemId: "a", widthMm: 500, heightMm: 300, bleedMm: 0 };
const PLACEMENT = placeMm(ITEM, 20, 30);
const JOB = { id: "J-COLL", name: "Shop window", date: "2026-01-01" };

const regMark = (id: string, xMm: number, yMm: number) => ({ id, xPt: mmToPt(xMm), yPt: mmToPt(yMm), dPt: mmToPt(5) });

/** A Spec 004 registration row along the left side of the medium, at x = 8 mm. */
const LEFT_ROW: RegistrationInput = {
  pattern: "edge-rows",
  originMarkId: "r1",
  marks: [regMark("r1", 8, 10), regMark("r2", 8, 200), regMark("r3", 8, 400)],
};

const labelOn = (edge: Edge) => ({ label: { edge } });

describe("collision with Spec 004 registration marks", () => {
  it("builds a square zone per mark and one zone per edge row, with the default 3 mm clearance", () => {
    expect(DEFAULT_REGISTRATION_CLEARANCE_MM).toBe(3);
    const zones = registrationZones(LEFT_ROW);
    expect(zones.map((z) => z.id)).toEqual(["mark:r1", "mark:r2", "mark:r3", "row:1"]);
    const row = zones.find((z) => z.id === "row:1")!.rect;
    expect(row.x).toBeCloseTo(8 - 2.5 - 3, 9);
    expect(row.w).toBeCloseTo(11, 9);
    expect(row.y).toBeCloseTo(10 - 5.5, 9);
    expect(row.y + row.h).toBeCloseTo(400 + 5.5, 9);

    const twoRows = registrationZones({ ...LEFT_ROW, marks: [...LEFT_ROW.marks, regMark("s1", 900, 10), regMark("s2", 900, 400)] });
    expect(twoRows.filter((z) => z.id.startsWith("row:"))).toHaveLength(2);
    expect(registrationZones({ ...LEFT_ROW, pattern: "corners-4" }).some((z) => z.id.startsWith("row:"))).toBe(false);
  });

  it("rejects a label on the edge used by a registration row with MarkCollisionError", async () => {
    const attempt = planFinishing({
      layout: { placements: [PLACEMENT] },
      items: [ITEM],
      job: JOB,
      finishing: labelOn("left"),
      registration: LEFT_ROW,
    });
    await expect(attempt).rejects.toBeInstanceOf(MarkCollisionError);
    const err = (await attempt.catch((e: unknown) => e)) as MarkCollisionError;
    expect(err.name).toBe("MarkCollisionError");
    expect(err.collisions.some((c) => c.elementId === "a#0/label" && c.zoneId === "row:1")).toBe(true);
    for (const c of err.collisions) expect(c.overlap.w > 0 && c.overlap.h > 0).toBe(true);
  });

  it("fails before rendering: the page, the OCG and /BPS_Layout are untouched", async () => {
    const imp = await imposeFixture([PLACEMENT], mmToPt(560), mmToPt(380), { originX: 0, originY: 0, scale: 1 });
    const { doc, ctx } = await hookContext(imp, [PLACEMENT]);
    const before = pageContent(doc);
    await expect(
      draw(ctx, { items: [ITEM], job: JOB, finishing: labelOn("left"), registration: LEFT_ROW }),
    ).rejects.toBeInstanceOf(MarkCollisionError);
    expect(pageContent(doc)).toBe(before);
    expect(doc.catalog.get(PDFName.of("OCProperties"))).toBeUndefined();
    expect(readLayoutMetadata(await PDFDocument.load(await doc.save()))).toBeUndefined();
  });

  it("accepts the same label on an edge clear of the registration row", async () => {
    const plan = await planFinishing({
      layout: { placements: [PLACEMENT] },
      items: [ITEM],
      job: JOB,
      finishing: labelOn("right"),
      registration: LEFT_ROW,
    });
    expect(plan.elements.map((e) => e.kind)).toEqual(["label"]);
  });

  it("only the continuous row zone blocks the left label; isolated corner marks leave room", async () => {
    const plan = await planFinishing({
      layout: { placements: [PLACEMENT] },
      items: [ITEM],
      job: JOB,
      finishing: labelOn("left"),
      registration: { ...LEFT_ROW, pattern: "corners-4", marks: [regMark("r1", 8, 10), regMark("r3", 8, 400)] },
    });
    expect(plan.elements).toHaveLength(1);
  });

  it("also rejects marks (not only labels) that enter a clearance zone", async () => {
    await expect(
      planFinishing({
        layout: { placements: [placeMm(ITEM, 15, 30)] },
        items: [ITEM],
        job: JOB,
        finishing: { marks: [{ kind: "crop" }] },
        registration: { pattern: "corners-4", originMarkId: "r1", marks: [regMark("r1", 8, 30)] },
      }),
    ).rejects.toBeInstanceOf(MarkCollisionError);
  });
});
