import { describe, expect, it } from "vitest";
import { mmToPt, panelItemId, tile, toNestItems } from "../src/index.js";

describe("FR7 panels as nest items", () => {
  const { panels } = tile({ widthMm: 3000, heightMm: 1000 }, { grid: { mode: "count", columns: 3, rows: 1 } });
  const trimOriginPt = { x: 10, y: 20 };

  it("references the source page with the panel's printed area as clip box", () => {
    const items = toNestItems(panels, { jobId: "job-42", pageIndex: 2, trimOriginPt });

    expect(items.map((i) => i.id)).toEqual(["job-42/panel/1-1", "job-42/panel/1-2", "job-42/panel/1-3"]);
    const middle = items[1];
    expect(middle).toMatchObject({
      jobId: "job-42",
      pageIndex: 2,
      quantity: 1,
      rotation: "none",
      lock: { orientation: 0 },
      panel: { id: "1-2", row: 1, col: 2, index: 2, label: "A2" },
    });
    expect(middle.clipBox.x).toBeCloseTo(10 + mmToPt(975), 9);
    expect(middle.clipBox.y).toBeCloseTo(20, 9);
    expect(middle.clipBox.width).toBeCloseTo(mmToPt(1050), 9);
    expect(middle.widthPt).toBe(middle.clipBox.width);
    expect(middle.heightPt).toBe(middle.clipBox.height);
  });

  it("names a single panel for reprint, with or without a job", () => {
    expect(panelItemId("2-3", "job-1")).toBe("job-1/panel/2-3");
    const [item] = toNestItems([panels[0]], { pageIndex: 0, trimOriginPt });
    expect(item.id).toBe("panel/1-1");
    expect("jobId" in item).toBe(false);
  });

  it("locks panels validated turned 90° to that orientation", () => {
    const turned = tile(
      { widthMm: 1500, heightMm: 1000 },
      { grid: { mode: "count", columns: 1, rows: 1 } },
      { printableWidthMm: 1300, maxLengthMm: 3000, allowRotation: true },
    );
    const [item] = toNestItems(turned.panels, { pageIndex: 0, trimOriginPt });
    expect(item.lock.orientation).toBe(90);
  });
});
