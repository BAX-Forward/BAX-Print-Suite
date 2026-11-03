import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  TEMPLATE_FIELDS,
  draw,
  pdfHexTextString,
  pdfLiteralString,
  pdfTextString,
  planFinishing,
  renderTemplate,
  type ItemInfo,
  type TemplateField,
} from "../src/index.js";
import { placeMm } from "./helpers.js";
import { hookContext, imposeFixture, pageContent } from "./pdf-helpers.js";

const VALUES: Record<TemplateField, string | number> = {
  "job.name": "Spring banner",
  "job.id": "J-1001",
  "job.customer": "Corner Bakery",
  "item.widthMm": 2000,
  "item.heightMm": 1000,
  "copy.index": 2,
  "copy.total": 3,
  "panel.row": 1,
  "panel.col": 4,
  "media.name": "PVC 510 g",
  "device.name": "Printer 2",
  date: "2026-03-14",
};

describe("label template", () => {
  it("documents exactly the spec's field list", () => {
    expect([...TEMPLATE_FIELDS].sort()).toEqual(Object.keys(VALUES).sort());
  });

  it.each(TEMPLATE_FIELDS.map((f) => [f]))("renders {{%s}}", (field) => {
    const { text, warnings } = renderTemplate(`[{{${field}}}]`, { fields: VALUES });
    expect(warnings).toEqual([]);
    expect(text).toBe(`[${VALUES[field]}]`);
  });

  it("renders meta.<key> from job ticket metadata", () => {
    const r = renderTemplate("PO {{meta.po}} / {{ meta.bin }}", { fields: {}, meta: { po: "PO-77", bin: 12 } });
    expect(r).toEqual({ text: "PO PO-77 / 12", warnings: [] });
  });

  it("renders an unknown field empty, with a warning", () => {
    const r = renderTemplate("a{{job.colour}}b", { fields: VALUES });
    expect(r.text).toBe("ab");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("job.colour");
  });

  it("renders missing metadata empty, with a warning", () => {
    const r = renderTemplate("<{{meta.nope}}>", { fields: {}, meta: {} });
    expect(r.text).toBe("<>");
    expect(r.warnings[0]).toContain("meta.nope");
  });

  it("renders a documented field without a value empty and silently", () => {
    expect(renderTemplate("<{{panel.row}}>", { fields: {} })).toEqual({ text: "<>", warnings: [] });
  });

  it("applies the upper, mm and in filters, chained", () => {
    const fields = { "job.name": "Spring banner", "item.widthMm": 2000, "item.heightMm": 254 };
    expect(renderTemplate("{{job.name|upper}}", { fields }).text).toBe("SPRING BANNER");
    expect(renderTemplate("{{item.widthMm|mm}}", { fields }).text).toBe("2000 mm");
    expect(renderTemplate("{{item.heightMm | in}}", { fields }).text).toBe("10 in");
    expect(renderTemplate("{{item.widthMm|in}}", { fields }).text).toBe("78.74 in");
    expect(renderTemplate("{{job.name|upper|upper}}", { fields }).text).toBe("SPRING BANNER");
  });

  it("warns about an unknown filter and keeps the value", () => {
    const r = renderTemplate("{{job.name|lower}}", { fields: VALUES });
    expect(r.text).toBe("Spring banner");
    expect(r.warnings[0]).toContain("lower");
  });

  it("does not HTML-escape: double, triple and & tags all insert the raw value", () => {
    const fields = { "job.name": `A & B <C> "D" 'E'` };
    for (const t of ["{{job.name}}", "{{{job.name}}}", "{{&job.name}}"]) {
      expect(renderTemplate(t, { fields }).text).toBe(`A & B <C> "D" 'E'`);
    }
  });

  it("drops comments and renders unsupported Mustache tags empty with a warning", () => {
    expect(renderTemplate("a{{! note }}b", { fields: {} })).toEqual({ text: "ab", warnings: [] });
    const r = renderTemplate("{{#job.name}}x{{/job.name}}", { fields: VALUES });
    expect(r.text).toBe("x");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("fills every field from the job, item, copy and panel during planning", async () => {
    const item: ItemInfo = { itemId: "banner", widthMm: 2000, heightMm: 1000, bleedMm: 0, copies: 3, panel: { row: 1, col: 4 } };
    const plan = await planFinishing({
      layout: { placements: [placeMm(item, 0, 0, 0, 1)] },
      items: [item],
      job: {
        id: "J-1001",
        name: "Spring banner",
        customer: "Corner Bakery",
        mediaName: "PVC 510 g",
        deviceName: "Printer 2",
        date: "2026-03-14",
        meta: { po: "PO-77" },
      },
      finishing: {
        label: { template: TEMPLATE_FIELDS.map((f) => `{{${f}}}`).join("|") + "|{{meta.po}}", code: { enabled: false } },
      },
    });
    expect(plan.warnings).toEqual([]);
    const part = plan.elements[0]!.parts[0]!;
    expect(part.type).toBe("label");
    if (part.type !== "label") return;
    expect(part.text).toBe(`${TEMPLATE_FIELDS.map((f) => VALUES[f]).join("|")}|PO-77`);
  });
});

describe("PDF string escaping", () => {
  it("escapes backslash, parentheses and control characters in literal strings", () => {
    expect(pdfLiteralString("a(b)c\\d")).toBe("(a\\(b\\)c\\\\d)");
    expect(pdfLiteralString("x\ny\tz\r")).toBe("(x\\ny\\tz\\r)");
  });

  it("uses UTF-16BE hex with a byte order mark for non-ASCII text", () => {
    expect(pdfHexTextString("é€")).toBe("<FEFF00E920AC>");
    expect(pdfTextString("Café")).toBe("<FEFF0043006100660065>".replace("0065>", "00E9>"));
    expect(pdfTextString("plain (ok)")).toBe("(plain \\(ok\\))");
  });

  it("escapes the label text in the PDF content stream (ActualText), but not as HTML", async () => {
    const item: ItemInfo = { itemId: "a", widthMm: 200, heightMm: 100, bleedMm: 0 };
    const placements = [placeMm(item, 20, 40)];
    const imp = await imposeFixture(placements, 700, 450, { originX: 0, originY: 0, scale: 1 });
    const { doc, ctx } = await hookContext(imp, placements);
    await draw(ctx, {
      items: [item],
      job: { id: "J-1", name: "Smith (UK) \\ A&B <x>", date: "2026-01-01" },
      finishing: { label: { template: "{{job.name}}", code: { enabled: false } } },
    });
    const content = pageContent(await PDFDocument.load(await doc.save()));
    expect(content).toContain("/ActualText (Smith \\(UK\\) \\\\ A&B <x>)");
    expect(content).not.toContain("&amp;");
  });
});
