import { PDFDict, PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  LAYOUT_INFO_KEY,
  PT_PER_MM,
  composeHooks,
  draw,
  labelCodes,
  marksHook,
  planFinishing,
  readLayoutMetadata,
  writeLayoutMetadata,
  type FinishingMetadata,
  type FinishingPlan,
  type FinishingSpecInput,
  type ItemInfo,
  type MarksHook,
} from "../src/index.js";
import { placeMm } from "./helpers.js";
import { hookContext, imposeFixture, pageContent, type Imposition } from "./pdf-helpers.js";

const BANNER: ItemInfo = { itemId: "banner", widthMm: 800, heightMm: 400, bleedMm: 3, panel: { row: 1, col: 2 } };
const PLACEMENTS = [placeMm(BANNER, 10, 20, 0, 0), placeMm(BANNER, 10, 460, 0, 1)];
const JOB = { id: "J-META", name: "Fair stand", customer: "Town hall", date: "2026-05-01" };
const FINISHING: FinishingSpecInput = {
  marks: [{ kind: "crop" }, { kind: "grommet" }, { kind: "fold-line", positionMm: 400 }],
  label: { edge: "bottom", template: "{{job.name}} {{copy.index}}/{{copy.total}}" },
};
const FRAME = { originX: 5 * PT_PER_MM, originY: 5 * PT_PER_MM, scale: 1 };

const fixture = (): Promise<Imposition> => imposeFixture(PLACEMENTS, 900 * PT_PER_MM, 960 * PT_PER_MM, FRAME);

async function drawOnce(imp: Imposition): Promise<{ content: string; layout: Record<string, unknown> | undefined }> {
  const { doc, ctx } = await hookContext(imp, PLACEMENTS);
  await draw(ctx, { items: [BANNER], job: JOB, finishing: FINISHING });
  const saved = await PDFDocument.load(await doc.save());
  return { content: pageContent(saved), layout: readLayoutMetadata(saved) };
}

describe("non-destructive, reproducible output (FR3)", () => {
  it("regenerating from the same inputs yields identical geometry, content and metadata", async () => {
    const imp = await fixture();
    const [a, b] = [await drawOnce(imp), await drawOnce(imp)];
    expect(b.content).toBe(a.content);
    expect(JSON.stringify(b.layout)).toBe(JSON.stringify(a.layout));

    const input = { layout: { placements: PLACEMENTS }, items: [BANNER], job: JOB, finishing: FINISHING };
    const [p1, p2] = [await planFinishing(input), await planFinishing(input)];
    expect(p2.elements).toEqual(p1.elements);
  });

  it("keeps the original page content, wrapped in q/Q ahead of the marks", async () => {
    const imp = await fixture();
    const original = pageContent(await PDFDocument.load(imp.bytes));
    const { content } = await drawOnce(imp);
    const marksAt = content.indexOf("/OC /BPSMarks BDC");
    expect(marksAt).toBeGreaterThan(0);
    expect(content.startsWith("q\n")).toBe(true);
    expect(content.slice(0, marksAt)).toContain(original.trim());
  });
});

describe("/BPS_Layout metadata (FR7)", () => {
  it("merges into an existing Spec 003 layout and lists every element with its code payload", async () => {
    const imp = await fixture();
    const { doc, ctx } = await hookContext(imp, PLACEMENTS);
    writeLayoutMetadata(doc, { version: 1, sheets: [{ widthMm: 900 }] });
    await draw(ctx, { items: [BANNER], job: JOB, finishing: FINISHING });

    const layout = readLayoutMetadata(await PDFDocument.load(await doc.save()))!;
    expect(layout.version).toBe(1);
    expect(layout.sheets).toEqual([{ widthMm: 900 }]);
    const meta = layout.finishing as FinishingMetadata;
    expect(meta).toMatchObject({ version: 1, units: "mm", frame: "layout" });
    expect(meta.elements.map((e) => e.id)).toEqual([
      "banner#0/crop",
      "banner#0/grommet",
      "banner#0/fold-line",
      "banner#0/label",
      "banner#1/crop",
      "banner#1/grommet",
      "banner#1/fold-line",
      "banner#1/label",
    ]);
    const labels = meta.elements.filter((e) => e.kind === "label").map((e) => e.parts[0]!);
    expect(labels.map((l) => (l.type === "label" ? [l.text, l.code?.payload] : []))).toEqual([
      ["Fair stand 1/2", "bps:job/J-META/panel/1-2"],
      ["Fair stand 2/2", "bps:job/J-META/panel/1-2"],
    ]);
  });

  it("replaces, rather than duplicates, the elements of a page drawn again", async () => {
    const imp = await fixture();
    const { doc, ctx } = await hookContext(imp, PLACEMENTS);
    await draw(ctx, { items: [BANNER], job: JOB, finishing: FINISHING });
    await draw(ctx, { items: [BANNER], job: JOB, finishing: { marks: [{ kind: "trim-line" }] } });
    const meta = readLayoutMetadata(doc)!.finishing as FinishingMetadata;
    expect(meta.elements.map((e) => e.markId)).toEqual(["trim-line", "trim-line"]);
  });

  it("skips the metadata on request", async () => {
    const { doc, ctx } = await hookContext(await fixture(), PLACEMENTS);
    await draw(ctx, { items: [BANNER], job: JOB, finishing: FINISHING }, { metadata: false });
    expect(readLayoutMetadata(doc)).toBeUndefined();
  });

  it("ignores a /BPS_Layout entry that is not a JSON object", async () => {
    const doc = await PDFDocument.create();
    expect(readLayoutMetadata(doc)).toBeUndefined();
    writeLayoutMetadata(doc, { ok: true });
    expect(readLayoutMetadata(doc)).toEqual({ ok: true });
    const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
    for (const text of ["[1, 2]", "null", "{broken"]) {
      info.set(PDFName.of(LAYOUT_INFO_KEY), PDFHexString.fromText(text));
      expect(readLayoutMetadata(doc)).toBeUndefined();
    }
  });

  it("lists label code payloads for cut export (CutJob.options.labelCode)", async () => {
    const plan = await planFinishing({ layout: { placements: PLACEMENTS }, items: [BANNER], job: JOB, finishing: FINISHING });
    expect(labelCodes(plan)).toEqual([
      { elementId: "banner#0/label", itemId: "banner", copy: 0, payload: "bps:job/J-META/panel/1-2" },
      { elementId: "banner#1/label", itemId: "banner", copy: 1, payload: "bps:job/J-META/panel/1-2" },
    ]);
  });
});

describe("Spec 003 marks hook", () => {
  it("marksHook draws and reports the plan; composeHooks runs hooks in order", async () => {
    const { doc, ctx } = await hookContext(await fixture(), PLACEMENTS);
    const order: string[] = [];
    const plans: FinishingPlan[] = [];
    const registration: MarksHook = async () => {
      order.push("registration");
    };
    const finishing = marksHook({ items: [BANNER], job: JOB, finishing: FINISHING }, (p) => {
      order.push("finishing");
      plans.push(p);
    });
    await composeHooks(registration, undefined, finishing)(ctx);
    expect(order).toEqual(["registration", "finishing"]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.elements).toHaveLength(8);
    expect(readLayoutMetadata(doc)?.finishing).toBeDefined();
  });

  it("leaves the page untouched when there is nothing to draw", async () => {
    const imp = await fixture();
    const { doc, ctx } = await hookContext(imp, PLACEMENTS);
    const before = pageContent(doc);
    const plan = await draw(ctx, { items: [BANNER], job: JOB, finishing: {} }, { metadata: false });
    expect(plan.elements).toEqual([]);
    expect(pageContent(doc)).toBe(before);
  });
});
