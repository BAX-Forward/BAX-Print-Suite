import { describe, expect, it } from "vitest";
import { MarkSpecError, labelPreviewSvg, planFinishing, type ItemInfo, type LabelPart } from "../src/index.js";
import { decodeQr, grayToRgba, placeMm, rasterize } from "./helpers.js";

const JOB = { id: "J-42", name: "Shop <window> & door", customer: "Town hall", date: "2026-03-01" };
const ITEM = { widthMm: 1200, heightMm: 600, copy: 1, copyTotal: 3, panel: { row: 2, col: 1 } };

const attr = (svg: string, el: string, name: string): string | undefined =>
  new RegExp(`<${el}[^>]*\\s${name}="([^"]*)"`).exec(svg)?.[1];

/** Rebuilds the module matrix from the code path's `M x y h…` squares. */
function codeModules(svg: string, moduleMm: number): boolean[][] {
  const d = /<path class="code"[^>]*\sd="([^"]*)"/.exec(svg)?.[1] ?? "";
  const corners = [...d.matchAll(/M(-?[\d.]+) (-?[\d.]+)h/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
  const minX = Math.min(...corners.map(([x]) => x));
  const minY = Math.min(...corners.map(([, y]) => y));
  const cells = corners.map(([x, y]) => [Math.round((y - minY) / moduleMm), Math.round((x - minX) / moduleMm)] as const);
  const size = Math.max(...cells.flat()) + 1;
  const grid = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  for (const [r, c] of cells) grid[r]![c] = true;
  return grid;
}

describe("label preview SVG", () => {
  it("renders the label text and a QR code that decodes to the job URI", async () => {
    const { svg, warnings } = labelPreviewSvg({
      label: { template: "{{job.name|upper}} {{copy.index}}/{{copy.total}} r{{panel.row}}c{{panel.col}}" },
      job: JOB,
      item: ITEM,
    });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain("<title>SHOP &#60;WINDOW&#62; &#38; DOOR 2/3 r2c1</title>");
    expect(svg).toContain("<desc>bps:job/J-42/panel/2-1</desc>");
    expect(svg).toContain('<path class="text"');
    expect(warnings.every((w) => !w.includes("unknown"))).toBe(true);

    const modules = codeModules(svg, 0.5);
    const img = rasterize(modules, 6, 4);
    expect(await decodeQr(grayToRgba(img), img.width, img.height)).toBe("bps:job/J-42/panel/2-1");
  });

  it("has the same size as the label planned for the PDF", async () => {
    const label = { edge: "top" as const, template: "{{job.id}} {{date}}", code: { moduleMm: 0.8 } };
    const { svg } = labelPreviewSvg({ label, job: JOB, item: { widthMm: 1200, heightMm: 600 } });
    const item: ItemInfo = { itemId: "x", widthMm: 1200, heightMm: 600 };
    const plan = await planFinishing({ layout: { placements: [placeMm(item, 0, 0)] }, items: [item], job: JOB, finishing: { label } });
    const part = plan.elements[0]!.parts[0] as LabelPart;
    const [, , w, h] = (attr(svg, "svg", "viewBox") ?? "").split(" ").map(Number);
    expect(w).toBeCloseTo(part.widthMm + 2, 3);
    expect(h).toBeCloseTo(part.heightMm + 2, 3);
    expect(attr(svg, "svg", "width")).toBe(`${w}mm`);
  });

  it("scales to a requested pixel width, keeping the aspect ratio", () => {
    const { svg } = labelPreviewSvg({ label: {}, job: JOB, item: ITEM, widthPx: 400 });
    const [, , w, h] = (attr(svg, "svg", "viewBox") ?? "").split(" ").map(Number);
    expect(Number(attr(svg, "svg", "width"))).toBe(400);
    expect(Number(attr(svg, "svg", "height"))).toBeCloseTo((400 * h!) / w!, 3);
  });

  it("omits the code when disabled and reports unknown fields as warnings", () => {
    const { svg, warnings } = labelPreviewSvg({
      label: { template: "{{job.id}} {{nope}}", code: { enabled: false } },
      job: JOB,
      item: ITEM,
    });
    expect(svg).not.toContain('class="code"');
    expect(svg).not.toContain("<desc>");
    expect(warnings.some((w) => w.includes("nope"))).toBe(true);
  });

  it("rejects an invalid or empty label", () => {
    expect(() => labelPreviewSvg({ label: { fontSizePt: 1 }, job: JOB, item: ITEM })).toThrow(MarkSpecError);
    expect(() => labelPreviewSvg({ label: { template: "", code: { enabled: false } }, job: JOB, item: ITEM })).toThrow(
      MarkSpecError,
    );
  });
});
