import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  CodeSpecSchema,
  DEFAULT_QUIET_ZONE,
  PT_PER_MM,
  codePayload,
  draw,
  encodeCode,
  encodeDataMatrix,
  planFinishing,
  readLayoutMetadata,
  type FinishingMetadata,
  type ItemInfo,
} from "../src/index.js";
import { decodeQr, grayToRgba, interop, rasterize, type GrayImage } from "./helpers.js";
import { cropGray, hookContext, imposeFixture, renderPage } from "./pdf-helpers.js";

type Zxing = typeof import("@zxing/library");

async function decodeDataMatrix(img: GrayImage): Promise<string> {
  const zx = interop<Zxing>(await import("@zxing/library"));
  const source = new zx.RGBLuminanceSource(img.gray, img.width, img.height);
  const bitmap = new zx.BinaryBitmap(new zx.HybridBinarizer(source));
  const hints = new Map([[zx.DecodeHintType.PURE_BARCODE, true]]);
  return new zx.DataMatrixReader().decode(bitmap, hints).getText();
}

const PAYLOADS = [
  codePayload({ payload: "uri" }, "J-1001"),
  codePayload({ payload: "uri" }, "J-1001", { row: 2, col: 3 }),
  codePayload({ payload: "url", baseUrl: "https://print.example.com/" }, "J-2026-0001", { row: 12, col: 1 }),
];

describe("code payload", () => {
  it("builds the bps: URI, with and without a panel", () => {
    expect(codePayload({ payload: "uri" }, "J-1001")).toBe("bps:job/J-1001");
    expect(codePayload({ payload: "uri" }, "J-1001", { row: 2, col: 3 })).toBe("bps:job/J-1001/panel/2-3");
  });

  it("builds the HTTPS job page URL and requires an https baseUrl", () => {
    expect(codePayload({ payload: "url", baseUrl: "https://print.example.com/" }, "J 7", { row: 1, col: 2 })).toBe(
      "https://print.example.com/jobs/J%207?panel=1-2",
    );
    expect(CodeSpecSchema.safeParse({ payload: "url" }).success).toBe(false);
    expect(CodeSpecSchema.safeParse({ payload: "url", baseUrl: "http://print.example.com" }).success).toBe(false);
  });
});

describe("QR code (ISO/IEC 18004)", () => {
  it.each(PAYLOADS.map((p) => [p]))("decodes back to %s", async (payload) => {
    const code = encodeCode("qr", payload);
    expect(code.symbology).toBe("qr");
    expect((code.size - 17) % 4).toBe(0);
    const img = rasterize(code.modules, 6, DEFAULT_QUIET_ZONE.qr);
    expect(await decodeQr(grayToRgba(img), img.width, img.height)).toBe(payload);
  });

  it("defaults to QR, 0.5 mm modules and a 4-module quiet zone, and rejects smaller modules", async () => {
    const spec = CodeSpecSchema.parse({});
    expect(spec).toMatchObject({ symbology: "qr", payload: "uri", moduleMm: 0.5 });
    expect(DEFAULT_QUIET_ZONE.qr).toBe(4);
    expect(CodeSpecSchema.safeParse({ moduleMm: 0.49 }).success).toBe(false);

    const item: ItemInfo = { itemId: "a", widthMm: 300, heightMm: 200 };
    for (const moduleMm of [0.5, 0.8]) {
      const plan = await planFinishing({
        layout: { placements: [{ itemId: "a", copy: 0, xPt: 0, yPt: 200, rotation: 0, footprint: { w: 300 * PT_PER_MM, h: 200 * PT_PER_MM } }] },
        items: [item],
        job: { id: "J-1001", date: "2026-01-01" },
        finishing: { label: { template: "", code: { moduleMm } } },
      });
      const part = plan.elements[0]!.parts[0]!;
      if (part.type !== "label" || !part.code) throw new Error("expected a label with a code");
      expect(part.code.moduleMm).toBeGreaterThanOrEqual(0.5);
      expect(part.code.moduleMm).toBe(moduleMm);
      expect(part.code.quietZoneModules).toBe(4);
      expect(part.code.sideMm).toBeCloseTo((part.code.size + 8) * moduleMm, 9);
      expect(part.code.payload).toBe("bps:job/J-1001");
    }
  });

  it("decodes from the pdf.js rendering of the imposed label to the exact URI", async () => {
    const item: ItemInfo = { itemId: "a", widthMm: 100, heightMm: 60, bleedMm: 2 };
    const footprint = { w: 104 * PT_PER_MM, h: 64 * PT_PER_MM };
    const placements = [{ itemId: "a", copy: 0, xPt: 10 * PT_PER_MM, yPt: 30 * PT_PER_MM, rotation: 0 as const, footprint }];
    const page = { w: 150 * PT_PER_MM, h: 110 * PT_PER_MM };
    const imp = await imposeFixture(placements, page.w, page.h, { originX: 0, originY: 0, scale: 1 });
    const { doc, ctx } = await hookContext(imp, placements);
    await draw(ctx, {
      items: [item],
      job: { id: "J-77", name: "Window film", date: "2026-02-01" },
      finishing: { label: { edge: "bottom" } },
    });
    const bytes = await doc.save();
    const meta = readLayoutMetadata(await PDFDocument.load(bytes))!.finishing as FinishingMetadata;
    const label = meta.elements.find((e) => e.kind === "label")!.parts[0]!;
    if (label.type !== "label" || !label.code) throw new Error("expected a label with a code");

    const scale = 4;
    const { image } = await renderPage(bytes, { scale });
    const b = label.code.bounds;
    const pad = 2;
    const x0 = Math.max(0, Math.floor(b.x * PT_PER_MM * scale) - pad);
    const y0 = Math.max(0, Math.floor((page.h - (b.y + b.h) * PT_PER_MM) * scale) - pad);
    const w = Math.min(image.width - x0, Math.ceil(b.w * PT_PER_MM * scale) + 2 * pad);
    const h = Math.min(image.height - y0, Math.ceil(b.h * PT_PER_MM * scale) + 2 * pad);
    const crop = cropGray(image, x0, y0, w, h);
    expect(await decodeQr(grayToRgba(crop), crop.width, crop.height)).toBe("bps:job/J-77");
  });
});

describe("Data Matrix (ISO/IEC 16022 ECC 200)", () => {
  const LONG = `https://print.example.com/jobs/${"J".repeat(160)}?panel=1-1`;

  it.each([...PAYLOADS, "12345678", LONG].map((p) => [p]))("decodes back to %s", async (payload) => {
    const dm = encodeDataMatrix(payload);
    const code = encodeCode("datamatrix", payload);
    expect(code.size).toBe(dm.size);
    const img = rasterize(code.modules, 4, DEFAULT_QUIET_ZONE.datamatrix);
    expect(await decodeDataMatrix(img)).toBe(payload);
  });

  it("compacts digit pairs and picks the smallest square symbol", () => {
    expect(encodeDataMatrix("123456").size).toBe(10);
    expect(encodeDataMatrix("bps:job/J-1001").size).toBe(16);
  });

  it("rejects payloads larger than the biggest supported symbol", () => {
    expect(() => encodeDataMatrix("x".repeat(400))).toThrow(/codewords/);
  });
});
