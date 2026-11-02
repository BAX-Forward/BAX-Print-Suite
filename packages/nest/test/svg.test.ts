import { XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { nest, toSvg } from "../src/index.js";
import type { Layout } from "../src/types.js";
import { INCH, item, roll } from "./helpers.js";

/** Fixed layout: two panels, all margins set, an id that needs escaping, rotated placements. */
const FIXED: Layout = {
  placements: [
    { itemId: "A&B", copy: 0, xPt: 0, yPt: 0, rotation: 0, footprint: { w: 40, h: 20 }, panel: 0 },
    { itemId: "C", copy: 1, xPt: 40, yPt: 0, rotation: 90, footprint: { w: 20, h: 30 }, panel: 0 },
    { itemId: "D", copy: 0, xPt: 0, yPt: 30, rotation: 180, footprint: { w: 30, h: 20 }, panel: 1 },
  ],
  mediaWidthPt: 100,
  lengthUsedPt: 50,
  utilization: 0.3,
  unplaced: [],
  algorithm: "fixed",
  elapsedMs: 0,
  media: { widthPt: 100, margins: { left: 5, right: 5, lead: 10, trail: 10 } },
  panels: [
    { index: 0, offsetPt: 0, lengthPt: 30 },
    { index: 1, offsetPt: 30, lengthPt: 20 },
  ],
};

const STYLE =
  ".media{fill:#fff;stroke:#333;stroke-width:1}" +
  ".margin{fill:url(#bps-hatch);stroke:none}" +
  ".hatch-line{stroke:#bbb;stroke-width:1}" +
  ".panel-break{stroke:#c00;stroke-width:1;stroke-dasharray:6 4}" +
  ".item{fill:#cfe3f7;stroke:#1f5a96;stroke-width:0.5}" +
  ".label{font-family:sans-serif;fill:#123;text-anchor:middle;dominant-baseline:middle}" +
  ".arrow{stroke:#123;fill:none;stroke-width:1}";

const GOLDEN = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="140" viewBox="0 0 100 70">',
  '<defs><pattern id="bps-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="hatch-line" x1="0" y1="0" x2="0" y2="8"/></pattern></defs>',
  `<style>${STYLE}</style>`,
  '<rect class="media" x="0" y="0" width="100" height="70"/>',
  '<rect class="margin" x="0" y="0" width="5" height="70"/>',
  '<rect class="margin" x="95" y="0" width="5" height="70"/>',
  '<rect class="margin" x="5" y="60" width="90" height="10"/>',
  '<rect class="margin" x="5" y="0" width="90" height="10"/>',
  '<line class="panel-break" x1="0" y1="30" x2="100" y2="30"/>',
  '<g class="placement" data-item="A&amp;B" data-copy="0" data-rotation="0"><rect class="item" x="5" y="40" width="40" height="20"/></g>',
  '<g class="placement" data-item="C" data-copy="1" data-rotation="90"><rect class="item" x="45" y="30" width="20" height="30"/></g>',
  '<g class="placement" data-item="D" data-copy="0" data-rotation="180"><rect class="item" x="5" y="10" width="30" height="20"/></g>',
  "</svg>",
  "",
].join("\n");

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

describe("toSvg", () => {
  it("matches the golden output for a fixed layout", () => {
    expect(toSvg(FIXED, { labels: false, widthPx: 200 })).toBe(GOLDEN);
  });

  it("is valid XML with one rect.item, label and arrow per placement", () => {
    const svg = toSvg(FIXED, { labels: true });
    expect(XMLValidator.validate(svg)).toBe(true);
    expect(count(svg, /<rect class="item"/g)).toBe(3);
    expect(count(svg, /<text class="label"/g)).toBe(3);
    expect(count(svg, /<path class="arrow"/g)).toBe(3);
    expect(svg).toContain(">A&amp;B #1</text>");
  });

  it("points the rotation arrow along the art's up direction", () => {
    const svg = toSvg(FIXED);
    expect(svg).toContain('d="M25 50L25 45'); // 0°: up (smaller SVG y)
    expect(svg).toContain('d="M55 45L50 45'); // 90° counter-clockwise: left
    expect(svg).toContain('d="M20 20L20 25'); // 180°: down
  });

  it("keeps the viewBox in points and scales the pixel size", () => {
    const svg = toSvg(FIXED, { widthPx: 1000 });
    expect(svg).toContain('width="1000" height="700" viewBox="0 0 100 70"');
  });

  it("has one rect.item per placement for a nested layout", () => {
    const items = [
      item("poster", 24 * INCH, 36 * INCH, { quantity: 5, rotation: "any" }),
      item("<card>", 4 * INCH, 6 * INCH, { quantity: 12, rotation: "90", bleedPt: 9 }),
    ];
    const layout = nest(roll(64 * INCH, 18), items, { gutterPt: 14, algorithm: "maxrects" });
    const svg = toSvg(layout);
    expect(XMLValidator.validate(svg)).toBe(true);
    expect(count(svg, /<rect class="item"/g)).toBe(layout.placements.length);
    expect(layout.placements).toHaveLength(17);
  });
});
