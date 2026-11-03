import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  MarkSpecError,
  PT_PER_MM,
  draw,
  parseFinishing,
  planFinishing,
  ptToMm,
  type FinishingPlan,
  type FinishingSpecInput,
  type ItemInfo,
  type LinesPart,
  type MarkPart,
  type Rotation,
  type Segment,
  type SymbolSource,
  type SymbolsPart,
} from "../src/index.js";
import { placeMm } from "./helpers.js";
import { hookContext, imposeFixture, pageContent } from "./pdf-helpers.js";

/** 1000 x 500 mm, no bleed, trim bottom-left at (10, 20) in the layout frame. */
const ITEM: ItemInfo = { itemId: "a", widthMm: 1000, heightMm: 500, bleedMm: 0 };
const JOB = { id: "J-K", date: "2026-01-01" };
const HALF_PT_MM = ptToMm(0.5);

const SVG_SYMBOL: SymbolSource = {
  type: "svg",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20"><rect width="10" height="20"/><circle cx="5" cy="10" r="3" fill="none" stroke="#000"/></svg>',
};

function plan(
  finishing: FinishingSpecInput,
  symbols?: Record<string, SymbolSource>,
  rotation: Rotation = 0,
): Promise<FinishingPlan> {
  return planFinishing({ layout: { placements: [placeMm(ITEM, 10, 20, rotation)] }, items: [ITEM], job: JOB, finishing, symbols });
}

const segs = (part: MarkPart | undefined): number[][] => {
  expect(part?.type).toBe("lines");
  return (part as LinesPart).segments.map((s: Segment) => [s.x1, s.y1, s.x2, s.y2]);
};

function expectSegments(actual: number[][], expected: number[][]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((s, i) => s.forEach((v, j) => expect(v).toBeCloseTo(expected[i]![j]!, 9)));
}

describe("hem and sew lines", () => {
  it("draws a dashed hem line per enabled edge, inside the trim", async () => {
    const p = await plan({ marks: [{ kind: "hem-line", edges: ["top", "bottom"] }] });
    const part = p.elements[0]!.parts[0] as LinesPart;
    expect(p.elements[0]!.kind).toBe("hem-line");
    expectSegments(segs(part), [
      [10, 490, 1010, 490],
      [10, 50, 1010, 50],
    ]);
    expect(part.dashMm).toEqual([6, 3]);
    expect(part.lineWidthMm).toBeCloseTo(HALF_PT_MM, 12);
  });

  it("uses its own defaults for sew lines and allows a negative (outside) offset", async () => {
    const p = await plan({ marks: [{ kind: "sew-line", edges: ["left", "right"] }, { kind: "hem-line", edges: ["left"], offsetMm: -10 }] });
    const sew = p.elements[0]!.parts[0] as LinesPart;
    expectSegments(segs(sew), [
      [25, 20, 25, 520],
      [995, 20, 995, 520],
    ]);
    expect(sew.dashMm).toEqual([2, 2]);
    expectSegments(segs(p.elements[1]!.parts[0]), [[0, 20, 0, 520]]);
  });

  it("warns when the offset is more than half the item", async () => {
    const p = await plan({ marks: [{ kind: "hem-line", edges: ["top"], offsetMm: 300 }] });
    expect(p.warnings.some((w) => w.includes("more than half"))).toBe(true);
  });
});

describe("fold lines", () => {
  it("draws a dashed vertical fold with tick marks outside the trim", async () => {
    const p = await plan({ marks: [{ kind: "fold-line", positionMm: 400 }] });
    const [line, ticks] = p.elements[0]!.parts;
    expectSegments(segs(line), [[410, 20, 410, 520]]);
    expect((line as LinesPart).dashMm).toEqual([4, 2]);
    expectSegments(segs(ticks), [
      [410, 17, 410, 11],
      [410, 523, 410, 529],
    ]);
    expect((ticks as LinesPart).dashMm).toBeUndefined();
  });

  it("starts the ticks beyond the bleed", async () => {
    const item: ItemInfo = { ...ITEM, bleedMm: 5 };
    const p = await planFinishing({
      layout: { placements: [placeMm(item, 0, 0)] },
      items: [item],
      job: JOB,
      finishing: { marks: [{ kind: "fold-line", axis: "horizontal", positionMm: 100 }] },
    });
    // Trim bottom-left at (5, 5); ticks start 5 mm (the bleed) outside the trim.
    expectSegments(segs(p.elements[0]!.parts[1]), [
      [0, 105, -6, 105],
      [1010, 105, 1016, 105],
    ]);
  });

  it("omits ticks on request and warns about a fold outside the trim", async () => {
    const p = await plan({ marks: [{ kind: "fold-line", axis: "horizontal", positionMm: 600, ticks: false }] });
    expect(p.elements[0]!.parts).toHaveLength(1);
    expectSegments(segs(p.elements[0]!.parts[0]), [[10, 620, 1010, 620]]);
    expect(p.warnings.some((w) => w.includes("fold position"))).toBe(true);
  });
});

describe("custom symbols", () => {
  it("places an SVG symbol at named anchors, sized by its aspect ratio", async () => {
    const p = await plan(
      { marks: [{ kind: "custom", symbolId: "eyelet", widthMm: 5, anchors: ["top-left", "center", "right"], offsetMm: [1, -1] }] },
      { eyelet: SVG_SYMBOL },
    );
    const part = p.elements[0]!.parts[0] as SymbolsPart;
    expect(part).toMatchObject({ type: "symbols", symbolId: "eyelet", widthMm: 5, heightMm: 10 });
    expectSegments(
      part.instances.map((i) => [i.center.x, i.center.y]),
      [
        [11, 519],
        [511, 269],
        [1011, 269],
      ],
    );
    expect(part.instances.every((i) => i.rotation === 0)).toBe(true);
  });

  it("repeats a symbol along edges at an interval, and rotates it with the artwork", async () => {
    const mark = { kind: "custom" as const, symbolId: "eyelet", widthMm: 4, repeat: { edges: ["bottom" as const], intervalMm: 300, insetMm: 50 } };
    const flat = (await plan({ marks: [mark] }, { eyelet: SVG_SYMBOL })).elements[0]!.parts[0] as SymbolsPart;
    expectSegments(
      flat.instances.map((i) => [i.center.x, i.center.y]),
      [
        [60, 70],
        [360, 70],
        [660, 70],
        [960, 70],
      ],
    );

    const turned = (await plan({ marks: [mark] }, { eyelet: SVG_SYMBOL }, 90)).elements[0]!.parts[0] as SymbolsPart;
    expect(turned.instances).toHaveLength(4);
    expect(turned.instances.every((i) => i.rotation === 90)).toBe(true);
  });

  it("requires exactly one of anchors or repeat, and a known symbol", async () => {
    expect(() => parseFinishing({ marks: [{ kind: "custom", symbolId: "x", widthMm: 5 }] })).toThrow(MarkSpecError);
    expect(() =>
      parseFinishing({
        marks: [{ kind: "custom", symbolId: "x", widthMm: 5, anchors: ["center"], repeat: { intervalMm: 100 } }],
      }),
    ).toThrow(MarkSpecError);
    await expect(plan({ marks: [{ kind: "custom", symbolId: "missing", widthMm: 5, anchors: ["center"] }] })).rejects.toThrow(
      /unknown symbol/,
    );
  });

  it("rejects SVG without supported shapes and warns about unsupported features", async () => {
    await expect(
      plan({ marks: [{ kind: "custom", symbolId: "t", widthMm: 5, anchors: ["center"] }] }, { t: { type: "svg", svg: '<svg viewBox="0 0 1 1"><text>x</text></svg>' } }),
    ).rejects.toThrow(MarkSpecError);
    const p = await plan(
      { marks: [{ kind: "custom", symbolId: "g", widthMm: 5, anchors: ["center"] }] },
      { g: { type: "svg", svg: '<svg viewBox="0 0 1 1"><rect width="1" height="1" transform="rotate(45)"/></svg>' } },
    );
    expect(p.warnings.some((w) => w.includes('symbol "g"') && w.includes("transform"))).toBe(true);
  });

  it("embeds a single-page PDF symbol as a Form XObject and draws SVG symbols as paths", async () => {
    const symDoc = await PDFDocument.create();
    symDoc.addPage([20, 10]).drawCircle({ x: 10, y: 5, size: 4 });
    const pdfSymbol: SymbolSource = { type: "pdf", bytes: await symDoc.save() };

    const placements = [placeMm(ITEM, 10, 20)];
    const imp = await imposeFixture(placements, 1100 * PT_PER_MM, 600 * PT_PER_MM, { originX: 0, originY: 0, scale: 1 });
    const { doc, ctx } = await hookContext(imp, placements);
    const result = await draw(ctx, {
      items: [ITEM],
      job: JOB,
      symbols: { logo: pdfSymbol, eyelet: SVG_SYMBOL },
      finishing: {
        marks: [
          { kind: "custom", symbolId: "logo", widthMm: 20, anchors: ["top-left", "bottom-right"] },
          { kind: "custom", symbolId: "eyelet", widthMm: 5, anchors: ["center"] },
        ],
      },
    });
    expect((result.elements[0]!.parts[0] as SymbolsPart).heightMm).toBeCloseTo(10, 9);

    const saved = await PDFDocument.load(await doc.save());
    const xobjects = saved.getPage(0).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    const sym = saved.context.lookup(xobjects.get(PDFName.of("BPSSym")));
    expect((sym as { dict?: PDFDict }).dict?.get(PDFName.of("Subtype"))).toBe(PDFName.of("Form"));
    const marks = pageContent(saved).split("/OC /BPSMarks BDC")[1] ?? "";
    expect(marks.match(/\/BPSSym Do/g)).toHaveLength(2);
    // The SVG rect is a closed, filled path; the unfilled circle is stroked at its 1-unit stroke width.
    expect(marks).toContain("h\nf");
    expect(marks).toContain("1 w 0 J 0 j [] 0 d");
  });

  it("rejects a multi-page PDF symbol", async () => {
    const symDoc = await PDFDocument.create();
    symDoc.addPage([10, 10]);
    symDoc.addPage([10, 10]);
    await expect(
      plan({ marks: [{ kind: "custom", symbolId: "two", widthMm: 5, anchors: ["center"] }] }, { two: { type: "pdf", bytes: await symDoc.save() } }),
    ).rejects.toThrow(/single-page/);
  });
});
