import { describe, expect, it } from "vitest";
import { suggest, tile, type SuggestResult, type Suggestion } from "../src/index.js";

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
