import { describe, expect, it } from "vitest";
import {
  MAX_KEEP_OUT_REGIONS,
  suggest,
  tile,
  type RectMm,
  type SuggestOptions,
  type SuggestResult,
  type Suggestion,
  type TileLimits,
  type TilePage,
} from "../src/index.js";

function ok(result: SuggestResult): Suggestion {
  if (!result.ok) throw new Error(`expected a suggestion, got ${JSON.stringify(result.issues)}`);
  return result.suggestion;
}

describe("FR4 auto-suggest", () => {
  const mural = { widthMm: 3000, heightMm: 1000 };
  const limits = { printableWidthMm: 1300 };

  it("proposes the fewest panels that satisfy the limits", () => {
    const s = ok(suggest(mural, {}, limits));

    expect(s.panelCount).toBe(3);
    expect(s.result.ok).toBe(true);
    expect(s.spec.seamsX).toEqual([1000, 2000]);
    // One fewer column cannot fit.
    expect(tile(mural, { grid: { mode: "count", columns: 2, rows: 1 } }, limits).ok).toBe(false);
  });

  it("the suggested spec reproduces the suggested panels", () => {
    const s = ok(suggest(mural, { seam: { kind: "overlap", overlapMm: 40 } }, limits));
    expect(tile(mural, s.spec, limits).panels).toEqual(s.result.panels);
  });

  it("prefers equal panel widths over seams that avoid a keep-out", () => {
    const face = { x: 980, y: 300, width: 40, height: 400 };
    const result = suggest(mural, { keepOut: [face] }, limits);
    const s = ok(result);

    expect(s.spec.seamsX).toEqual([1000, 2000]);
    expect(s.keepOutHits).toBe(1);
    expect(s.widthSpreadMm).toBe(0);
    // The seam-moving alternative was considered and ranked lower.
    expect(result.ok && result.alternatives.some((a) => a.keepOutHits === 0)).toBe(true);
  });

  it("moves a seam off a keep-out when the width tolerance allows it", () => {
    const face = { x: 980, y: 300, width: 40, height: 400 };
    const s = ok(suggest(mural, { keepOut: [face], widthToleranceMm: 200 }, limits));

    expect(s.panelCount).toBe(3);
    expect(s.keepOutHits).toBe(0);
    // The overlap band (seam ± 25 mm) now clears the region on the nearer side.
    expect(s.spec.seamsX).toEqual([955, 2000]);
    for (const p of s.result.panels) expect(p.printed.width).toBeLessThanOrEqual(1300);
  });

  it("keeps seams in place when moving them would break the limits", () => {
    // Moving seam 1000 to 955 would make the middle panel 1045 + 50 mm printed > 1060.
    const face = { x: 980, y: 0, width: 40, height: 1000 };
    const s = ok(suggest(mural, { keepOut: [face], widthToleranceMm: 500 }, { printableWidthMm: 1060 }));
    expect(s.spec.seamsX).toEqual([1000, 2000]);
  });

  it("turns panels 90° when that needs fewer of them, otherwise prefers unrotated", () => {
    const banner = { widthMm: 1400, heightMm: 1000 };
    const device = { printableWidthMm: 1300, maxLengthMm: 5000 };

    expect(ok(suggest(banner, {}, device)).panelCount).toBe(2);
    const turned = ok(suggest(banner, {}, { ...device, allowRotation: true }));
    expect(turned).toMatchObject({ panelCount: 1, rotated: true });
    expect(turned.result.panels[0].rotate).toBe(true);

    const small = ok(suggest({ widthMm: 1000, heightMm: 1000 }, {}, { ...device, allowRotation: true }));
    expect(small).toMatchObject({ panelCount: 1, rotated: false });
  });

  it("respects user size limits with the chosen accounting", () => {
    const s = ok(suggest(mural, { maxWidthMm: 1010, accounting: "visible" }, {}));
    expect(s.result.columns).toBe(3);
    const printed = ok(suggest(mural, { maxWidthMm: 1010, accounting: "printed" }, {}));
    expect(printed.result.columns).toBe(4);
  });

  it("explains failures instead of throwing", () => {
    const tooNarrow = suggest(mural, {}, { printableWidthMm: 20 });
    expect(tooNarrow.ok).toBe(false);
    expect(!tooNarrow.ok && tooNarrow.issues.map((i) => i.code)).toContain("no-grid-fits");

    const badKeepOut = suggest(mural, { keepOut: [{ x: 0, y: 0, width: -1, height: 10 }] }, limits);
    expect(!badKeepOut.ok && badKeepOut.issues[0].code).toBe("invalid-keep-out");
  });
});

function codes(result: SuggestResult): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe("FR4 keep-out tie-break", () => {
  const mural = { widthMm: 3000, heightMm: 1000 };
  const limits = { printableWidthMm: 1300 };
  const butt = { kind: "butt" } as const;

  it("absent, undefined or empty keepOut gives today's output", () => {
    const cases: [TilePage, SuggestOptions, TileLimits][] = [
      [mural, {}, limits],
      [mural, { seam: { kind: "overlap", overlapMm: 40 } }, limits],
      [mural, { widthToleranceMm: 200 }, limits],
      [{ widthMm: 1400, heightMm: 1000 }, {}, { printableWidthMm: 1300, maxLengthMm: 5000 }],
      [{ widthMm: 1400, heightMm: 1000 }, {}, { printableWidthMm: 1300, maxLengthMm: 5000, allowRotation: true }],
      [mural, { maxWidthMm: 1010, accounting: "visible" }, {}],
      [mural, { maxWidthMm: 1010, accounting: "printed" }, {}],
      [mural, {}, { printableWidthMm: 20 }],
    ];
    for (const [page, options, lim] of cases) {
      const absent = suggest(page, options, lim);
      expect(suggest(page, { ...options, keepOut: undefined }, lim)).toEqual(absent);
      expect(suggest(page, { ...options, keepOut: [] }, lim)).toEqual(absent);
    }
  });

  it("picks the tied grid whose seams avoid the keep-out over the one today's order prefers", () => {
    const face = { x: 980, y: 300, width: 40, height: 400 };
    const options = { widthToleranceMm: 200 };

    // Without keep-outs the uniform grid wins on width spread.
    expect(ok(suggest(mural, options, limits)).spec.seamsX).toEqual([1000, 2000]);

    const result = suggest(mural, { ...options, keepOut: [face] }, limits);
    const s = ok(result);
    expect(s.spec.seamsX).toEqual([955, 2000]);
    expect(s.keepOutHits).toBe(0);
    // Same panel count and both within the width tolerance: only the seams differ.
    const uniform = result.ok ? result.alternatives.find((a) => a.spec.seamsX?.[0] === 1000) : undefined;
    expect(uniform).toMatchObject({ panelCount: s.panelCount, keepOutHits: 1, widthSpreadMm: 0 });
  });

  it("a butt seam crosses a region only when strictly inside it", () => {
    const hits = (keepOut: RectMm[]): number => ok(suggest(mural, { seam: butt, keepOut }, limits)).keepOutHits;

    // Seams at 1000 and 2000.
    expect(hits([{ x: 1000, y: 0, width: 40, height: 1000 }])).toBe(0); // left edge on the seam
    expect(hits([{ x: 960, y: 0, width: 40, height: 1000 }])).toBe(0); // right edge on the seam
    expect(hits([{ x: 990, y: 0, width: 20, height: 1000 }])).toBe(1); // strictly inside
  });

  it("an overlap seam is its overlap band; touching the band edge does not cross", () => {
    // Default overlap: the seam at 1000 occupies (975, 1025).
    const hits = (keepOut: RectMm[]): number => ok(suggest(mural, { keepOut }, limits)).keepOutHits;
    expect(hits([{ x: 1025, y: 0, width: 40, height: 1000 }])).toBe(0);
    expect(hits([{ x: 935, y: 0, width: 40, height: 1000 }])).toBe(0);
    expect(hits([{ x: 1024, y: 0, width: 40, height: 1000 }])).toBe(1);
  });

  it("horizontal seams cross on y the same way", () => {
    const tall = { widthMm: 1000, heightMm: 3000 };
    const hits = (keepOut: RectMm[]): number =>
      ok(suggest(tall, { seam: butt, keepOut }, { maxLengthMm: 1300 })).keepOutHits;
    expect(hits([{ x: 0, y: 2000, width: 1000, height: 10 }])).toBe(0);
    expect(hits([{ x: 0, y: 1995, width: 1000, height: 10 }])).toBe(1);
  });

  it("counts (seam, region) pairs", () => {
    const hits = (keepOut: RectMm[]): number => ok(suggest(mural, { seam: butt, keepOut }, limits)).keepOutHits;
    // One region across both seams counts twice.
    expect(hits([{ x: 900, y: 0, width: 1200, height: 100 }])).toBe(2);
    // Two regions across one seam count twice.
    expect(
      hits([
        { x: 990, y: 0, width: 20, height: 100 },
        { x: 995, y: 500, width: 10, height: 100 },
      ]),
    ).toBe(2);
  });

  it("remaining ties keep today's order", () => {
    // Both orientations give the same 3 x 2 grid and cross the region once; unrotated stays first.
    const page = { widthMm: 3000, heightMm: 2000 };
    const lim = { printableWidthMm: 1200, maxLengthMm: 1200, allowRotation: true };
    const result = suggest(page, { keepOut: [{ x: 990, y: 100, width: 20, height: 200 }] }, lim);
    const s = ok(result);
    expect(s).toMatchObject({ rotated: false, keepOutHits: 1 });
    const next = result.ok ? result.alternatives[0] : undefined;
    expect(next).toMatchObject({ rotated: true, keepOutHits: 1, panelCount: s.panelCount });
    expect(next?.spec.seamsX).toEqual(s.spec.seamsX);

    // A region no seam crosses changes nothing.
    const clear = [{ x: 100, y: 100, width: 100, height: 100 }];
    const withClear = suggest(mural, { keepOut: clear }, limits);
    const without = suggest(mural, {}, limits);
    expect(withClear.ok && withClear.suggestion.spec).toEqual(without.ok && without.suggestion.spec);
  });

  it("is deterministic and independent of region order", () => {
    const keepOut = [
      { x: 980, y: 300, width: 40, height: 400 },
      { x: 1990, y: 0, width: 30, height: 50 },
    ];
    const options = { keepOut, widthToleranceMm: 200 };
    const first = suggest(mural, options, limits);
    expect(suggest(mural, options, limits)).toEqual(first);
    const reversed = suggest(mural, { ...options, keepOut: [...keepOut].reverse() }, limits);
    expect(ok(reversed).spec).toEqual(ok(first).spec);
  });

  it("rejects invalid regions with issues instead of throwing", () => {
    const bad: RectMm[] = [
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      { x: 0, y: Number.POSITIVE_INFINITY, width: 10, height: 10 },
      { x: -1, y: 0, width: 10, height: 10 },
      { x: 0, y: -1, width: 10, height: 10 },
      { x: 0, y: 0, width: -1, height: 10 },
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: 0 },
      { x: 2995, y: 0, width: 10, height: 10 },
      { x: 0, y: 995, width: 10, height: 10 },
    ];
    for (const region of bad) {
      const run = (): SuggestResult => suggest(mural, { keepOut: [region] }, limits);
      expect(run).not.toThrow();
      expect(codes(run())).toEqual(["invalid-keep-out"]);
    }

    // One issue per bad region, naming its index.
    const mixed = suggest(mural, { keepOut: [{ x: 0, y: 0, width: 10, height: 10 }, ...bad.slice(0, 2)] }, limits);
    expect(mixed.ok ? [] : mixed.issues.map((i) => i.message.split(" ")[2])).toEqual(["1", "2"]);

    // A region exactly filling the artwork is valid.
    expect(suggest(mural, { keepOut: [{ x: 0, y: 0, width: 3000, height: 1000 }] }, limits).ok).toBe(true);
  });

  it(`accepts up to ${MAX_KEEP_OUT_REGIONS} regions`, () => {
    expect(MAX_KEEP_OUT_REGIONS).toBe(256);
    const regions = (n: number): RectMm[] =>
      Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 0, width: 5, height: 5 }));

    expect(suggest(mural, { keepOut: regions(MAX_KEEP_OUT_REGIONS) }, limits).ok).toBe(true);
    const tooMany = suggest(mural, { keepOut: regions(MAX_KEEP_OUT_REGIONS + 1) }, limits);
    expect(codes(tooMany)).toEqual(["invalid-keep-out"]);
  });

  it("leaves an invalid page to tile's invalid-page issue", () => {
    const run = (): SuggestResult =>
      suggest({ widthMm: Number.NaN, heightMm: 1000 }, { keepOut: [{ x: 0, y: 0, width: 10, height: 10 }] }, limits);
    expect(run).not.toThrow();
    expect(codes(run())).toContain("invalid-page");
  });
});
