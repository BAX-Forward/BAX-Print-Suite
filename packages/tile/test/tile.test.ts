import { describe, expect, it } from "vitest";
import { tile, type Panel, type TileResult } from "../src/index.js";

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const firstRow = (result: TileResult): Panel[] => result.panels.filter((p) => p.row === 1);
const codes = (result: TileResult): string[] => result.issues.map((i) => i.code);

describe("acceptance: 3000 × 1000 mm artwork, 1300 mm printed width, 25 mm overlap", () => {
  const page = { widthMm: 3000, heightMm: 1000 };

  it("gives 3 columns by user size limit with printed accounting", () => {
    const result = tile(page, { grid: { mode: "size", maxWidthMm: 1300 }, accounting: "printed", seam: { kind: "overlap", overlapMm: 25 } });

    expect(result.ok).toBe(true);
    expect(result.columns).toBe(3);
    expect(result.rows).toBe(1);
    for (const panel of result.panels) expect(panel.printed.width).toBeLessThanOrEqual(1300);
    expect(sum(firstRow(result).map((p) => p.visible.width))).toBeCloseTo(3000, 9);
  });

  it("gives 3 columns by the device printable width with the default 25 mm overlap", () => {
    const result = tile(page, { grid: { mode: "size" } }, { printableWidthMm: 1300 });

    expect(result.ok).toBe(true);
    expect(result.columns).toBe(3);
    expect(result.panels.map((p) => p.printed.width)).toEqual([1025, 1050, 1025]);
    expect(result.panels.map((p) => p.visible.width)).toEqual([1000, 1000, 1000]);
    expect(result.seamsX).toEqual([1000, 2000]);
  });
});

describe("FR1 grid definition", () => {
  it("splits uniformly by count; row 1 is the top row and indices run row-major", () => {
    const result = tile({ widthMm: 2000, heightMm: 1000 }, { grid: { mode: "count", columns: 2, rows: 2 }, seam: { kind: "butt" } });

    expect(result.ok).toBe(true);
    expect(result.panels.map((p) => [p.id, p.index])).toEqual([
      ["1-1", 1],
      ["1-2", 2],
      ["2-1", 3],
      ["2-2", 4],
    ]);
    expect(result.panels[0].visible).toEqual({ x: 0, y: 500, width: 1000, height: 500 });
    expect(result.panels[3].visible).toEqual({ x: 1000, y: 0, width: 1000, height: 500 });
  });

  it("keeps individually positioned seams and lets them override the grid on that axis", () => {
    const result = tile(
      { widthMm: 3000, heightMm: 2000 },
      { grid: { mode: "count", columns: 5, rows: 2 }, seamsX: [700, 1900], seam: { kind: "butt" } },
    );

    expect(result.ok).toBe(true);
    expect(result.seamsX).toEqual([700, 1900]);
    expect(result.seamsY).toEqual([1000]);
    expect(firstRow(result).map((p) => p.visible.width)).toEqual([700, 1200, 1100]);
  });

  it("rejects seams that are unsorted or outside the artwork", () => {
    const page = { widthMm: 1000, heightMm: 1000 };
    const grid = { mode: "count", columns: 1, rows: 1 } as const;

    for (const seamsX of [[600, 400], [0], [1000], [Number.NaN]]) {
      const result = tile(page, { grid, seamsX });
      expect(result.ok).toBe(false);
      expect(result.panels).toEqual([]);
      expect(codes(result)).toContain("invalid-seam");
    }
  });

  it("rejects invalid counts, sizes and artwork without throwing", () => {
    expect(codes(tile({ widthMm: 1000, heightMm: 1000 }, { grid: { mode: "count", columns: 0, rows: 1 } }))).toContain("invalid-grid");
    expect(codes(tile({ widthMm: 1000, heightMm: 1000 }, { grid: { mode: "count", columns: 1.5, rows: 1 } }))).toContain("invalid-grid");
    expect(codes(tile({ widthMm: 1000, heightMm: 1000 }, { grid: { mode: "size", maxWidthMm: -1 } }))).toContain("invalid-grid");
    expect(codes(tile({ widthMm: 0, heightMm: 1000 }, { grid: { mode: "size" } }))).toContain("invalid-page");
    expect(codes(tile({ widthMm: 1000, heightMm: 1000 }, { grid: { mode: "size" } }, { printableWidthMm: 0 }))).toContain("invalid-limits");
  });
});

describe("FR2 seam treatment", () => {
  const page = { widthMm: 2000, heightMm: 500 };

  it("overlap: both neighbours print past the seam", () => {
    const result = tile(page, { grid: { mode: "count", columns: 2, rows: 1 }, seam: { kind: "overlap", overlapMm: 30 } });
    const [left, right] = result.panels;

    expect(left.printed).toEqual({ x: 0, y: 0, width: 1030, height: 500 });
    expect(right.printed).toEqual({ x: 970, y: 0, width: 1030, height: 500 });
    expect(left.edges).toEqual({ left: "outer", right: "overlap", bottom: "outer", top: "outer" });
    expect(left.overlapMm.right).toBe(30);
    expect(right.overlapMm.left).toBe(30);
  });

  it("defaults to a 25 mm overlap", () => {
    const [left] = tile(page, { grid: { mode: "count", columns: 2, rows: 1 } }).panels;
    expect(left.printed.width).toBe(1025);
  });

  it("butt: panels meet exactly at the seam", () => {
    const [left, right] = tile(page, { grid: { mode: "count", columns: 2, rows: 1 }, seam: { kind: "butt" } }).panels;
    expect(left.printed).toEqual(left.visible);
    expect(right.printed.x).toBe(1000);
  });

  it("gap: a strip centred on the seam is left unprinted", () => {
    const [left, right] = tile(page, { grid: { mode: "count", columns: 2, rows: 1 }, seam: { kind: "gap", gapMm: 10 } }).panels;
    expect(left.visible).toEqual({ x: 0, y: 0, width: 995, height: 500 });
    expect(right.visible).toEqual({ x: 1005, y: 0, width: 995, height: 500 });
    expect(left.edges.right).toBe("gap");
  });

  it("applies per-seam treatments, falling back to the default for empty slots", () => {
    const result = tile(
      { widthMm: 3000, heightMm: 500 },
      { grid: { mode: "count", columns: 3, rows: 1 }, seam: { kind: "butt" }, seamTreatmentsX: [null, { kind: "overlap", overlapMm: 20 }] },
    );
    const [a, b, c] = result.panels;

    expect(a.edges.right).toBe("butt");
    expect(b.edges).toMatchObject({ left: "butt", right: "overlap" });
    expect(b.printed).toEqual({ x: 1000, y: 0, width: 1020, height: 500 });
    expect(c.printed.x).toBe(1980);
  });

  it("flags an overlap wider than a neighbouring panel and invalid treatments", () => {
    const tooWide = tile({ widthMm: 1000, heightMm: 500 }, { grid: { mode: "count", columns: 1, rows: 1 }, seamsX: [20] });
    expect(codes(tooWide)).toContain("overlap-exceeds-panel");

    const badGap = tile(page, { grid: { mode: "count", columns: 2, rows: 1 }, seam: { kind: "gap", gapMm: 0 } });
    expect(codes(badGap)).toContain("invalid-treatment");

    const badOverlap = tile(page, { grid: { mode: "count", columns: 2, rows: 1 }, seamTreatmentsX: [{ kind: "overlap", overlapMm: -1 }] });
    expect(badOverlap.issues[0]).toMatchObject({ code: "invalid-treatment", axis: "x", seamIndex: 0 });
  });

  it("adds bleed on every edge of every panel", () => {
    const [left] = tile(page, { grid: { mode: "count", columns: 2, rows: 1 }, seam: { kind: "butt" }, bleedMm: 5 }).panels;
    expect(left.printed).toEqual({ x: -5, y: -5, width: 1010, height: 510 });
  });
});

describe("FR3 size accounting and validation", () => {
  const page = { widthMm: 3000, heightMm: 1000 };

  it("visible accounting measures the user limit without overlap; printed accounting includes it", () => {
    const visible = tile(page, { grid: { mode: "size", maxWidthMm: 1010 }, accounting: "visible" });
    const printed = tile(page, { grid: { mode: "size", maxWidthMm: 1010 }, accounting: "printed" });

    expect(visible.columns).toBe(3);
    expect(printed.columns).toBe(4);
    for (const p of printed.panels) expect(p.printed.width).toBeLessThanOrEqual(1010);
  });

  it("always validates the printed size against the device, even with visible accounting", () => {
    const result = tile(
      { widthMm: 2550, heightMm: 1000 },
      { grid: { mode: "size", maxWidthMm: 1300 }, accounting: "visible" },
      { printableWidthMm: 1290 },
    );

    expect(result.ok).toBe(true);
    expect(result.columns).toBe(3);
    for (const p of result.panels) expect(p.printed.width).toBeLessThanOrEqual(1290);
  });

  it("uses the narrower of printable width and medium width", () => {
    const result = tile(page, { grid: { mode: "size" } }, { printableWidthMm: 1300, mediaWidthMm: 1000 });
    expect(result.columns).toBe(4);
    for (const p of result.panels) expect(p.printed.width).toBeLessThanOrEqual(1000);
  });

  it("splits along the feed by the maximum length", () => {
    const result = tile({ widthMm: 1000, heightMm: 5000 }, { grid: { mode: "size" } }, { maxLengthMm: 2000 });
    expect(result.rows).toBe(3);
    for (const p of result.panels) expect(p.printed.height).toBeLessThanOrEqual(2000);
  });

  it("returns panels with issues when a count grid exceeds the device and medium", () => {
    const result = tile(page, { grid: { mode: "count", columns: 2, rows: 1 } }, { printableWidthMm: 1300, mediaWidthMm: 1270, maxLengthMm: 900 });

    expect(result.ok).toBe(false);
    expect(result.panels).toHaveLength(2);
    expect(codes(result)).toEqual(expect.arrayContaining(["exceeds-printable-width", "exceeds-media-width", "exceeds-max-length"]));
    expect(result.issues.every((i) => i.panelId !== undefined)).toBe(true);
  });

  it("turns a panel 90° when allowed and only that fits", () => {
    const limits = { printableWidthMm: 1300, maxLengthMm: 3000 };
    const spec = { grid: { mode: "count", columns: 1, rows: 1 } } as const;

    expect(tile({ widthMm: 1500, heightMm: 1000 }, spec, limits).ok).toBe(false);
    const turned = tile({ widthMm: 1500, heightMm: 1000 }, spec, { ...limits, allowRotation: true });
    expect(turned.ok).toBe(true);
    expect(turned.panels[0].rotate).toBe(true);
  });

  it("holds explicitly positioned seams to a size grid's limit", () => {
    const result = tile(page, { grid: { mode: "size", maxWidthMm: 1300 }, seamsX: [1400, 2000] });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ code: "exceeds-size-limit", panelId: "1-1" });
  });

  it("reports when no grid can fit because overlap and bleed exceed the limit", () => {
    const result = tile(page, { grid: { mode: "size" }, bleedMm: 5 }, { printableWidthMm: 40 });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("no-grid-fits");
  });
});
