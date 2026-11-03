import { describe, expect, it } from "vitest";
import { clipContours, contoursForPanels, mmToPt, tile, type Contour, type Point } from "../src/index.js";

/** Acceptance tolerance for unchanged geometry. */
const TOLERANCE_PT = mmToPt(0.01);

function contour(id: string, points: Point[], closed: boolean): Contour {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    twiceArea += x0 * y1 - x1 * y0;
  }
  return {
    id,
    tool: "cut",
    source: { kind: "spot", name: "CutContour" },
    closed,
    points,
    bbox: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    areaSigned: closed ? twiceArea / 2 : 0,
  };
}

/** A closed circle in pt, starting at angle 0 (its rightmost point), counter-clockwise. */
function circle(id: string, cxMm: number, cyMm: number, rMm: number, n = 360): Contour {
  const points = Array.from({ length: n }, (_, k): Point => {
    const a = (2 * Math.PI * k) / n;
    return [mmToPt(cxMm + rMm * Math.cos(a)), mmToPt(cyMm + rMm * Math.sin(a))];
  });
  return contour(id, points, true);
}

const page = { widthMm: 2000, heightMm: 1000 };

describe("acceptance: cut paths clipped to panels", () => {
  for (const [name, seam] of [
    ["overlap", { kind: "overlap", overlapMm: 25 }],
    ["butt", { kind: "butt" }],
  ] as const) {
    it(`a circle spanning a ${name} seam splits into two open fragments`, () => {
      const result = tile(page, { grid: { mode: "count", columns: 2, rows: 1 }, seam });
      const ring = circle("c1", 1000, 500, 100);
      const byPanel = contoursForPanels([ring], result.panels);

      const fragments = result.panels.flatMap((p) => byPanel.get(p.id) ?? []);
      expect(fragments).toHaveLength(2);
      for (const f of fragments) {
        expect(f).toMatchObject({ clip: "open", closed: false, sourceContourId: "c1", areaSigned: 0 });
        expect(f.points.length).toBeGreaterThan(2);
      }

      // Each fragment ends on its panel's printed edge at the seam (panel frame).
      const [left, right] = result.panels;
      const [a] = byPanel.get(left.id) ?? [];
      const [b] = byPanel.get(right.id) ?? [];
      const leftEdge = mmToPt(left.printed.width);
      for (const p of [a.points[0], a.points[a.points.length - 1]]) expect(p[0]).toBeCloseTo(leftEdge, 6);
      for (const p of [b.points[0], b.points[b.points.length - 1]]) expect(p[0]).toBeCloseTo(0, 6);
      expect(a.bbox.maxX).toBeCloseTo(leftEdge, 6);
    });
  }

  it("leaves a contour fully inside one panel unchanged (within 0.01 mm) and absent from the others", () => {
    const result = tile(page, { grid: { mode: "count", columns: 2, rows: 1 } });
    const ring = circle("c2", 1500, 500, 100);
    const byPanel = contoursForPanels([ring], result.panels);
    const [left, right] = result.panels;

    expect(byPanel.get(left.id)).toEqual([]);
    const [kept] = byPanel.get(right.id) ?? [];
    expect(kept).toMatchObject({ clip: "whole", closed: true, id: "c2", areaSigned: ring.areaSigned });
    expect(kept.points).toHaveLength(ring.points.length);

    // Back to the artwork frame: the panel's printed origin plus the local point.
    const ox = mmToPt(right.printed.x);
    const oy = mmToPt(right.printed.y);
    kept.points.forEach(([x, y], i) => {
      expect(Math.abs(x + ox - ring.points[i][0])).toBeLessThanOrEqual(TOLERANCE_PT);
      expect(Math.abs(y + oy - ring.points[i][1])).toBeLessThanOrEqual(TOLERANCE_PT);
    });
  });

  it("does not mutate the input contours", () => {
    const ring = circle("c3", 50, 50, 40);
    const before = structuredClone(ring);
    const [kept] = clipContours([ring], { x: 0, y: 0, width: 1000, height: 1000 });
    kept.points[0][0] = -1;
    expect(ring).toEqual(before);
  });
});

describe("clipContours on open paths", () => {
  const area = { x: 0, y: 0, width: 100, height: 100 };

  it("cuts a polyline that leaves and re-enters into separate fragments", () => {
    const zigzag = contour("z", [[10, 50], [150, 50], [150, 60], [10, 60]], false);
    const out = clipContours([zigzag], area);

    const rounded = (points: Point[]): Point[] => points.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);
    expect(out.map((c) => c.id)).toEqual(["z#1", "z#2"]);
    expect(rounded(out[0].points)).toEqual([[10, 50], [100, 50]]);
    expect(rounded(out[1].points)).toEqual([[100, 60], [10, 60]]);
    expect(out.every((c) => c.clip === "open" && !c.closed)).toBe(true);
  });

  it("drops contours entirely outside the area", () => {
    expect(clipContours([contour("far", [[200, 200], [300, 200], [300, 300]], true)], area)).toEqual([]);
  });

  it("keeps a contour that only touches the area's edge as whole", () => {
    const onEdge = contour("edge", [[0, 0], [100, 0], [100, 100], [0, 100]], true);
    expect(clipContours([onEdge], area)[0].clip).toBe("whole");
  });
});
