import { PDFDocument, PDFName, PDFString } from "pdf-lib";

export const SPOT_NAME = "TestSpot";
export const LAYER_NAME = "Test Layer";

export interface ArtOptions {
  readonly widthPt: number;
  readonly heightPt: number;
  /** Bleed on each side: MediaBox = BleedBox = trim + bleed, TrimBox inset by it. */
  readonly bleedPt?: number;
  /** OutputConditionIdentifier of a GTS_PDFX OutputIntent. */
  readonly outputIntent?: string;
  /** Adds a page-level /Group /S /Transparency. */
  readonly transparencyGroup?: boolean;
}

/**
 * One-page source PDF: four quadrant colors (so rotation is visible) and a
 * centered square painted in the spot color `TestSpot`, inside an optional
 * content group. No text, so rendering needs no fonts.
 */
export async function artPdf(opts: ArtOptions): Promise<Uint8Array> {
  const bleed = opts.bleedPt ?? 0;
  const w = opts.widthPt + 2 * bleed;
  const h = opts.heightPt + 2 * bleed;
  const doc = await PDFDocument.create();
  const { context } = doc;
  const page = doc.addPage([w, h]);
  page.setTrimBox(bleed, bleed, opts.widthPt, opts.heightPt);
  page.setBleedBox(0, 0, w, h);

  const tint = context.register(
    context.obj({ FunctionType: 2, Domain: [0, 1], C0: [1, 1, 1], C1: [1, 0, 1], N: 1 }),
  );
  const ocg = context.register(context.obj({ Type: "OCG", Name: PDFString.of(LAYER_NAME) }));
  page.node.set(
    PDFName.of("Resources"),
    context.obj({
      ColorSpace: { CS0: ["Separation", SPOT_NAME, "DeviceRGB", tint] },
      Properties: { OC0: ocg },
    }),
  );

  const cx = w / 2;
  const cy = h / 2;
  const side = Math.min(w, h) / 4;
  const operators = [
    `1 0 0 rg 0 0 ${cx} ${cy} re f`,
    `0 0 1 rg ${cx} 0 ${w - cx} ${cy} re f`,
    `0 0.5 0 rg 0 ${cy} ${cx} ${h - cy} re f`,
    `1 0.8 0 rg ${cx} ${cy} ${w - cx} ${h - cy} re f`,
    `/OC /OC0 BDC /CS0 cs 1 scn ${cx - side / 2} ${cy - side / 2} ${side} ${side} re f EMC`,
  ];
  page.node.set(PDFName.of("Contents"), context.register(context.stream(operators.join("\n"))));

  doc.catalog.set(
    PDFName.of("OCProperties"),
    context.obj({ OCGs: [ocg], D: { Order: [ocg], ON: [ocg] } }),
  );
  if (opts.outputIntent !== undefined) {
    const intent = context.obj({
      Type: "OutputIntent",
      S: "GTS_PDFX",
      OutputConditionIdentifier: PDFString.of(opts.outputIntent),
    });
    doc.catalog.set(PDFName.of("OutputIntents"), context.obj([intent]));
  }
  if (opts.transparencyGroup) {
    page.node.set(PDFName.of("Group"), context.obj({ Type: "Group", S: "Transparency", CS: "DeviceRGB" }));
  }
  return doc.save({ useObjectStreams: false });
}
