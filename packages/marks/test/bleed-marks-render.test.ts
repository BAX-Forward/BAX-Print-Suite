import { createHash } from "node:crypto";
import fc from "fast-check";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  CropMarkSchema,
  FinishingSpecSchema,
  MarkSpecError,
  bleedMarkSegments,
  draw,
  exportPresets,
  mmToPt,
  parsePreset,
  planFinishing,
  ptToMm,
  resolveFinishing,
  type FinishingSpecInput,
  type ImposeFrame,
  type ItemInfo,
  type LinesPart,
  type Placement,
  type PlannedElement,
  type Rotation,
} from "../src/index.js";
import { rectsOverlap, strokeBounds, type Rect } from "../src/geometry.js";
import { partShapes } from "../src/parts.js";
import { placeMm } from "./helpers.js";
import { pageContent } from "./pdf-helpers.js";

/** US Letter. */
const SHEET_W_PT = 612;
const SHEET_H_PT = 792;
const FRAME: ImposeFrame = { originX: 0, originY: 0, scale: 1 };
const JOB = { id: "J-046B", name: "Golden", customer: "Clean Room", date: "2026-01-01" };
const MARKS_BEGIN = "/OC /BPSMarks BDC";

const CARD: ItemInfo = { itemId: "card", widthMm: 100, heightMm: 150, bleedMm: 3 };
const TAG: ItemInfo = { itemId: "tag", widthMm: 80, heightMm: 50, bleedMm: 2 };
const FLAT: ItemInfo = { itemId: "flat", widthMm: 60, heightMm: 40 };

interface Fixture {
  readonly name: string;
  readonly items: readonly ItemInfo[];
  readonly placements: readonly Placement[];
  readonly finishing: FinishingSpecInput;
}

const PRESET = parsePreset({
  id: "letter-cards",
  name: "Letter cards",
  appliesTo: { queues: ["q-letter"] },
  finishing: {
    colorant: "registration",
    marks: [{ kind: "crop", offsetMm: 4, lengthMm: 5 }, { kind: "trim-line" }],
    label: { edge: "top", code: { enabled: false } },
  },
});

const CROP_ON_CARD: Fixture = {
  name: "crop marks on a bled card",
  items: [CARD],
  placements: [placeMm(CARD, 20, 20)],
  finishing: { marks: [{ kind: "crop" }] },
};

const FIXTURES: readonly Fixture[] = [
  CROP_ON_CARD,
  {
    name: "crop marks without bleed",
    items: [FLAT],
    placements: [placeMm(FLAT, 30, 200)],
    finishing: { marks: [{ kind: "crop", offsetMm: 2 }] },
  },
  {
    name: "every stroked kind with a label, one item rotated",
    items: [CARD, TAG],
    placements: [placeMm(CARD, 20, 20), placeMm(TAG, 140, 30, 90)],
    finishing: {
      marks: [
        { kind: "crop" },
        { kind: "trim-line" },
        { kind: "grommet", insetMm: 10, spacingMm: 40 },
        { kind: "hem-line", edges: ["top", "bottom"], offsetMm: 5 },
        { kind: "sew-line", edges: ["left"], offsetMm: 4 },
        { kind: "fold-line", positionMm: 40 },
      ],
      label: { edge: "bottom" },
    },
  },
  {
    name: "a resolved preset",
    items: [CARD],
    placements: [placeMm(CARD, 20, 20)],
    finishing: resolveFinishing({ presets: [PRESET], queueId: "q-letter" }),
  },
];

function withBleedMarks(finishing: FinishingSpecInput, value: boolean): FinishingSpecInput {
  return {
    ...finishing,
    marks: (finishing.marks ?? []).map((m) => (m.kind === "crop" ? { ...m, bleedMarks: value } : m)),
  };
}

async function blankSheet(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([SHEET_W_PT, SHEET_H_PT]);
  return doc.save();
}

/** The marks PDF for a fixture: draw() on a fresh Letter sheet, saved without dates. */
async function render(fx: Fixture, finishing: FinishingSpecInput = fx.finishing): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await blankSheet(), { updateMetadata: false });
  await draw(
    { page: doc.getPage(0), layout: { placements: fx.placements }, frame: FRAME },
    { items: fx.items, job: JOB, finishing },
  );
  return doc.save();
}

async function marksStream(bytes: Uint8Array): Promise<string> {
  const text = pageContent(await PDFDocument.load(bytes, { updateMetadata: false }));
  const start = text.indexOf(MARKS_BEGIN);
  expect(start).toBeGreaterThanOrEqual(0);
  return text.slice(start);
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  if (v === undefined) throw new Error(`no element ${i}`);
  return v;
}

function linesPart(el: PlannedElement, i: number): LinesPart {
  const part = at(el.parts, i);
  if (part.type !== "lines") throw new Error(`part ${i} of ${el.id} is ${part.type}, not lines`);
  return part;
}

const HEADER = [MARKS_BEGIN, "q", "2.8346 0 0 2.8346 0 0 cm", "/BPSMarksCS cs /BPSMarksCS CS 1 scn 1 SCN"];
const FOOTER = ["Q", "EMC", ""];
/** 0.25 pt in mm, as the existing crop marks draw it. */
const STROKE = "0.0882 w 0 J 0 j [] 0 d";

/** Crop marks of CARD (100 x 150 mm, bleed 3) at (20, 20) mm: trim box 23..123 x 23..173. */
const CROP_BLOCK = [
  STROKE,
  "20 23 m 14 23 l",
  "23 20 m 23 14 l",
  "126 23 m 132 23 l",
  "123 20 m 123 14 l",
  "126 173 m 132 173 l",
  "123 176 m 123 182 l",
  "20 173 m 14 173 l",
  "23 176 m 23 182 l",
  "S",
];

/** Bleed marks of the same card: bleed box 20..126 x 20..176, 3 mm offset, 6 mm long. */
const BLEED_BLOCK = [
  STROKE,
  "17 20 m 11 20 l",
  "20 17 m 20 11 l",
  "129 20 m 135 20 l",
  "126 17 m 126 11 l",
  "129 176 m 135 176 l",
  "126 179 m 126 185 l",
  "17 176 m 11 176 l",
  "20 179 m 20 185 l",
  "S",
];

/** Pinned output of the unchanged (field absent) path for CROP_ON_CARD. */
const CROP_ONLY_STREAM = [...HEADER, ...CROP_BLOCK, ...FOOTER].join("\n");
const CROP_AND_BLEED_STREAM = [...HEADER, ...CROP_BLOCK, ...BLEED_BLOCK, ...FOOTER].join("\n");

describe("bleed marks: schema", () => {
  it("is absent by default and stays absent after parsing and export", () => {
    const spec = CropMarkSchema.parse({ kind: "crop" });
    expect("bleedMarks" in spec).toBe(false);
    expect(exportPresets(PRESET)).not.toContain("bleedMarks");
  });

  it("accepts true and false", () => {
    expect(CropMarkSchema.parse({ kind: "crop", bleedMarks: true }).bleedMarks).toBe(true);
    expect(CropMarkSchema.parse({ kind: "crop", bleedMarks: false }).bleedMarks).toBe(false);
  });

  it.each([["yes"], ["true"], [1], [0], [null], [{}], [[]]])("rejects bleedMarks %j", (value) => {
    expect(CropMarkSchema.safeParse({ kind: "crop", bleedMarks: value }).success).toBe(false);
    expect(FinishingSpecSchema.safeParse({ marks: [{ kind: "crop", bleedMarks: value }] }).success).toBe(false);
    expect(() =>
      parsePreset({ id: "p", name: "P", finishing: { marks: [{ kind: "crop", bleedMarks: value }] } }),
    ).toThrow(MarkSpecError);
  });

  it("round-trips through presets and job overrides", () => {
    const preset = parsePreset({ id: "p", name: "P", finishing: { marks: [{ kind: "crop", bleedMarks: true }] } });
    expect(exportPresets(preset)).toContain('"bleedMarks": true');
    const resolved = resolveFinishing({ presets: [PRESET], override: { presetId: PRESET.id, marks: [{ kind: "crop", bleedMarks: true }] } });
    expect(at(resolved.marks, 0)).toMatchObject({ kind: "crop", offsetMm: 4, lengthMm: 5, bleedMarks: true });
    expect(() =>
      resolveFinishing({ presets: [PRESET], override: { presetId: PRESET.id, marks: [{ kind: "crop", bleedMarks: "on" }] } }),
    ).toThrow(MarkSpecError);
  });
});

describe("bleed marks: absent path is unchanged", () => {
  it("pins the exact marks stream of an existing crop plan", async () => {
    expect(await marksStream(await render(CROP_ON_CARD))).toBe(CROP_ONLY_STREAM);
  });

  it.each(FIXTURES.map((fx) => [fx.name, fx] as const))("%s: absent, false and a second render are byte-equal", async (_name, fx) => {
    const absent = await render(fx);
    const again = await render(fx);
    const off = await render(fx, withBleedMarks(fx.finishing, false));
    expect(again).toEqual(absent);
    expect(off).toEqual(absent);
    expect(sha256(off)).toBe(sha256(absent));
    expect(off.length).toBe(absent.length);
  });

  it("draws nothing extra when the item has no bleed", async () => {
    const fx = at(FIXTURES, 1);
    expect(await render(fx, withBleedMarks(fx.finishing, true))).toEqual(await render(fx));
  });
});

describe("bleed marks: golden render on a US Letter sheet", () => {
  const on = withBleedMarks(CROP_ON_CARD.finishing, true);

  it("draws the 046a bleed segments after the crop marks with the crop stroke", async () => {
    const stream = await marksStream(await render(CROP_ON_CARD, on));
    expect(stream).toBe(CROP_AND_BLEED_STREAM);
    // The only difference to the unchanged output is the bleed block.
    expect(stream.replace(`${BLEED_BLOCK.join("\n")}\n`, "")).toBe(CROP_ONLY_STREAM);
  });

  it("is deterministic: two renders are byte-equal", async () => {
    const a = await render(CROP_ON_CARD, on);
    const b = await render(CROP_ON_CARD, on);
    expect(b).toEqual(a);
    expect(sha256(b)).toBe(sha256(a));
    expect(a).not.toEqual(await render(CROP_ON_CARD));
  });

  it("plans the segments bleedMarkSegments() returns, mapped to the layout frame", async () => {
    const plan = await planFinishing({
      layout: { placements: CROP_ON_CARD.placements },
      items: CROP_ON_CARD.items,
      job: JOB,
      finishing: on,
    });
    const crop = at(plan.elements, 0);
    expect(crop.parts).toHaveLength(2);
    expect(linesPart(crop, 1).lineWidthMm).toBe(linesPart(crop, 0).lineWidthMm);
    const reference = bleedMarkSegments({
      trim: { x: mmToPt(23), y: mmToPt(23), width: mmToPt(100), height: mmToPt(150) },
      bleed: mmToPt(3),
      offset: mmToPt(3),
      length: mmToPt(6),
    });
    const planned = linesPart(crop, 1).segments;
    expect(planned).toHaveLength(reference.length);
    reference.forEach((r, i) => {
      const s = at(planned, i);
      expect(s.x1).toBeCloseTo(ptToMm(r.x1), 9);
      expect(s.y1).toBeCloseTo(ptToMm(r.y1), 9);
      expect(s.x2).toBeCloseTo(ptToMm(r.x2), 9);
      expect(s.y2).toBeCloseTo(ptToMm(r.y2), 9);
    });
  });
});

describe("bleed marks: geometry in plans", () => {
  it("keeps the label clear of the bleed marks", async () => {
    const plan = await planFinishing({
      layout: { placements: [placeMm(CARD, 20, 20)] },
      items: [CARD],
      job: JOB,
      finishing: { marks: [{ kind: "crop", bleedMarks: true }], label: { edge: "bottom" } },
    });
    const bleed = linesPart(at(plan.elements, 0), 1);
    const label = at(plan.elements, 1);
    expect(label.kind).toBe("label");
    const labelShapes = label.parts.flatMap(partShapes);
    for (const s of bleed.segments) {
      for (const r of labelShapes) expect(rectsOverlap(strokeBounds(s, bleed.lineWidthMm), r)).toBe(false);
    }
  });

  it("rejects items over the 046a size limit only when bleed marks are on", async () => {
    const huge: ItemInfo = { itemId: "huge", widthMm: 6_000, heightMm: 100, bleedMm: 3 };
    const input = { layout: { placements: [placeMm(huge, 0, 0)] }, items: [huge], job: JOB };
    await expect(planFinishing({ ...input, finishing: { marks: [{ kind: "crop" }] } })).resolves.toBeDefined();
    await expect(planFinishing({ ...input, finishing: { marks: [{ kind: "crop", bleedMarks: true }] } })).rejects.toThrow(
      MarkSpecError,
    );
  });

  it("property: bleed marks never intersect the bleed box, for random boxes and rotations", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          w: fc.double({ min: 10, max: 5_000, noNaN: true }),
          h: fc.double({ min: 10, max: 5_000, noNaN: true }),
          bleed: fc.double({ min: 0.1, max: 20, noNaN: true }),
          offset: fc.double({ min: 0, max: 20, noNaN: true }),
          length: fc.double({ min: 0.5, max: 30, noNaN: true }),
          lineWidthPt: fc.double({ min: 0.05, max: 2, noNaN: true }),
          x: fc.double({ min: 0, max: 3_000, noNaN: true }),
          y: fc.double({ min: 0, max: 3_000, noNaN: true }),
          rotation: fc.constantFrom<Rotation>(0, 90, 180, 270),
        }),
        async (r) => {
          const item: ItemInfo = { itemId: "a", widthMm: r.w, heightMm: r.h, bleedMm: r.bleed };
          const placement = placeMm(item, r.x, r.y, r.rotation);
          const plan = await planFinishing({
            layout: { placements: [placement] },
            items: [item],
            job: JOB,
            finishing: {
              marks: [
                { kind: "crop", offsetMm: r.offset, lengthMm: r.length, lineWidthPt: r.lineWidthPt, bleedMarks: true },
              ],
            },
          });
          const bleedBox: Rect = {
            x: ptToMm(placement.xPt),
            y: ptToMm(placement.yPt),
            w: ptToMm(placement.footprint.w),
            h: ptToMm(placement.footprint.h),
          };
          const part = linesPart(at(plan.elements, 0), 1);
          expect(part.segments).toHaveLength(8);
          for (const s of part.segments) {
            expect(rectsOverlap(strokeBounds(s, part.lineWidthMm), bleedBox)).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
