import { CutterDriverError } from "@bax-print/plugin-sdk";
import { PDFDocument, PDFName, PDFNumber, type PDFPage } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { readPageBoxes } from "../src/index.js";

/** A one-page 600 × 400 pt PDF; `setup` adds boxes and entries before it is saved. */
async function pdfWith(setup: (page: PDFPage, pdf: PDFDocument) => void = () => undefined): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 400]);
  setup(page, pdf);
  return pdf.save();
}

const MEDIA = { x0: 0, y0: 0, x1: 600, y1: 400 };

async function rejection(promise: Promise<unknown>): Promise<CutterDriverError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CutterDriverError);
  if (!(error instanceof CutterDriverError)) throw new Error("expected a CutterDriverError");
  return error;
}

describe("readPageBoxes (Spec 007h)", () => {
  it("reads the MediaBox, CropBox and TrimBox of a page", async () => {
    const bytes = await pdfWith((page) => {
      page.setCropBox(5, 5, 590, 390);
      page.setTrimBox(10, 20, 300, 200);
    });

    expect(await readPageBoxes(bytes)).toEqual({
      mediaBox: MEDIA,
      cropBox: { x0: 5, y0: 5, x1: 595, y1: 395 },
      trimBox: { x0: 10, y0: 20, x1: 310, y1: 220 },
      rotate: 0,
      userUnit: 1,
    });
  });

  it("falls back to the CropBox without a TrimBox", async () => {
    const bytes = await pdfWith((page) => page.setCropBox(5, 5, 590, 390));

    const boxes = await readPageBoxes(bytes);

    expect(boxes.cropBox).toEqual({ x0: 5, y0: 5, x1: 595, y1: 395 });
    expect(boxes.trimBox).toEqual(boxes.cropBox);
  });

  it("falls back to the MediaBox without a CropBox or TrimBox", async () => {
    const boxes = await readPageBoxes(await pdfWith());

    expect(boxes).toEqual({ mediaBox: MEDIA, cropBox: MEDIA, trimBox: MEDIA, rotate: 0, userUnit: 1 });
  });

  it("normalises corner order and clips the TrimBox to the CropBox", async () => {
    const bytes = await pdfWith((page) => {
      page.node.set(PDFName.of("TrimBox"), page.doc.context.obj([700, 300, -50, 100]));
    });

    expect((await readPageBoxes(bytes)).trimBox).toEqual({ x0: 0, y0: 100, x1: 600, y1: 300 });
  });

  it("reads /Rotate 90 of the page", async () => {
    const bytes = await pdfWith((page) => page.node.set(PDFName.of("Rotate"), PDFNumber.of(90)));

    expect((await readPageBoxes(bytes)).rotate).toBe(90);
  });

  it("inherits /Rotate from the parent Pages node and normalises it", async () => {
    const bytes = await pdfWith((_page, pdf) => pdf.catalog.Pages().set(PDFName.of("Rotate"), PDFNumber.of(-90)));

    expect((await readPageBoxes(bytes)).rotate).toBe(270);
  });

  it("normalises a /Rotate beyond a full turn", async () => {
    const bytes = await pdfWith((page) => page.node.set(PDFName.of("Rotate"), PDFNumber.of(450)));

    expect((await readPageBoxes(bytes)).rotate).toBe(90);
  });

  it("rejects a /Rotate that is not a multiple of 90", async () => {
    const bytes = await pdfWith((page) => page.node.set(PDFName.of("Rotate"), PDFNumber.of(45)));

    expect((await rejection(readPageBoxes(bytes))).code).toBe("invalid-job");
  });

  it("reads /UserUnit 2 without scaling the boxes", async () => {
    const bytes = await pdfWith((page) => page.node.set(PDFName.of("UserUnit"), PDFNumber.of(2)));

    const boxes = await readPageBoxes(bytes);

    expect(boxes.userUnit).toBe(2);
    expect(boxes.mediaBox).toEqual(MEDIA);
  });

  it("reads the page at the given index", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([600, 400]);
    pdf.addPage([200, 100]);

    expect((await readPageBoxes(await pdf.save(), 1)).mediaBox).toEqual({ x0: 0, y0: 0, x1: 200, y1: 100 });
  });

  it("rejects bytes that are not a PDF", async () => {
    const error = await rejection(readPageBoxes(new TextEncoder().encode("not a pdf at all")));

    expect(error.code).toBe("invalid-job");
    expect(error.message).toContain("not a readable PDF");
  });

  it("rejects a PDF header without a document behind it", async () => {
    const error = await rejection(readPageBoxes(new TextEncoder().encode("%PDF-1.7 sticker")));

    expect(error.code).toBe("invalid-job");
    expect(error.message).toContain("not a readable PDF");
  });

  it.each([1, -1, 0.5])("rejects page index %s on a one-page document", async (pageIndex) => {
    const error = await rejection(readPageBoxes(await pdfWith(), pageIndex));

    expect(error.code).toBe("invalid-job");
    expect(error.message).toContain("out of range");
  });
});
