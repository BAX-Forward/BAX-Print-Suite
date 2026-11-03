/**
 * FR7: one PDF page per panel, built from the source page as a Form XObject
 * (ISO 32000-2 §8.10) whose BBox is the panel's printed area, drawn under an
 * explicit clipping path (§8.5.4). Vector content, spot colours and optional
 * content come through unchanged because nothing is rasterized.
 */
import { clip, endPath, PDFDocument, popGraphicsState, pushGraphicsState, rectangle } from "pdf-lib";
import { panelClipBox } from "./nest-item.js";
import type { Panel } from "./types.js";

/** Form space = source page user space, so the BBox and offsets below are in page coordinates. */
const IDENTITY: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

/**
 * Pages are in the order of `panels` (pass a single panel to reprint just
 * that one). Each page is the panel's printed size. The artwork frame is the
 * source page's TrimBox (pdf-lib falls back to CropBox, then MediaBox).
 */
export async function panelPdf(sourcePdf: Uint8Array, pageIndex: number, panels: readonly Panel[]): Promise<Uint8Array> {
  const source = await PDFDocument.load(sourcePdf);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= source.getPageCount()) {
    throw new RangeError(`page index ${pageIndex} is outside the document (${source.getPageCount()} pages)`);
  }
  const trim = source.getPage(pageIndex).getTrimBox();

  const out = await PDFDocument.create();
  // Copy first so the embedded page and its resources live in the output document.
  const [page] = await out.copyPages(source, [pageIndex]);
  if (!page) throw new Error(`page ${pageIndex} could not be copied`);

  for (const panel of panels) {
    const box = panelClipBox(panel, { x: trim.x, y: trim.y });
    const form = await out.embedPage(
      page,
      { left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height },
      IDENTITY,
    );
    const target = out.addPage([box.width, box.height]);
    target.pushOperators(pushGraphicsState(), rectangle(0, 0, box.width, box.height), clip(), endPath());
    target.drawPage(form, { x: -box.x, y: -box.y });
    target.pushOperators(popGraphicsState());
  }

  out.setTitle(`Panels ${panels.map((p) => p.label).join(", ")}`);
  out.setCreator("BAX Print Suite");
  return out.save();
}
