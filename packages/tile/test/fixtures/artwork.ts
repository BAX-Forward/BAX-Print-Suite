/**
 * Project-owned test artwork, generated so the fixture is reviewable code
 * rather than an opaque binary.
 *
 * A page of flat-colour cells plus a dark bar, with a TrimBox inset by a bleed
 * margin. Every edge sits on a whole millimetre, and renders use 2 px/mm, so
 * cell, seam, overlap and panel edges all land on pixel boundaries: renders of
 * a panel and of the full page then sample identical pixels without
 * anti-aliasing noise.
 */
import { PDFDocument, rgb } from "pdf-lib";
import { mmToPt, type TilePage } from "../../src/index.js";

/** Artwork (TrimBox) size. */
export const ART: TilePage = { widthMm: 300, heightMm: 160 };

/** Bleed drawn around the trim, so panels with `bleedMm` > 0 have content to show. */
export const ART_BLEED_MM = 5;

/** Cells are offset from the seams so that seams and overlaps cut through cells. */
const CELL_W_MM = 30;
const CELL_H_MM = 20;

const channel = (n: number): number => (n % 256) / 255;

export async function artworkPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const mediaW = ART.widthMm + 2 * ART_BLEED_MM;
  const mediaH = ART.heightMm + 2 * ART_BLEED_MM;
  const page = doc.addPage([mmToPt(mediaW), mmToPt(mediaH)]);
  page.setTrimBox(mmToPt(ART_BLEED_MM), mmToPt(ART_BLEED_MM), mmToPt(ART.widthMm), mmToPt(ART.heightMm));

  for (let i = 0; i * CELL_W_MM < mediaW; i++) {
    for (let j = 0; j * CELL_H_MM < mediaH; j++) {
      page.drawRectangle({
        x: mmToPt(i * CELL_W_MM),
        y: mmToPt(j * CELL_H_MM),
        width: mmToPt(CELL_W_MM),
        height: mmToPt(CELL_H_MM),
        color: rgb(channel(i * 67 + j * 29 + 20), channel(i * 13 + j * 97 + 40), channel(i * 151 + j * 7 + 90)),
      });
    }
  }
  // A narrow dark bar crossing every vertical seam and overlap strip.
  page.drawRectangle({
    x: 0,
    y: mmToPt(ART_BLEED_MM + 41),
    width: mmToPt(mediaW),
    height: mmToPt(2),
    color: rgb(0.1, 0.1, 0.1),
  });

  // Fixed dates keep the bytes deterministic.
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  return doc.save();
}
