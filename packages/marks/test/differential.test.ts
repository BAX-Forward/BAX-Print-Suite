import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  PT_PER_MM,
  draw,
  readLayoutMetadata,
  type FinishingMetadata,
  type FinishingSpecInput,
  type ItemInfo,
  type JobInfo,
  type PartMetadata,
  type Rect,
  type Rotation,
} from "../src/index.js";
import { placeMm } from "./helpers.js";
import { hookContext, imposeFixture } from "./pdf-helpers.js";

type ExpectedPart =
  | { readonly type: "lines"; readonly segments: number[][] }
  | { readonly type: "dots"; readonly centers: number[][]; readonly diameterMm: number }
  | {
      readonly type: "label";
      readonly edge: string;
      readonly bounds: Rect;
      readonly code: { readonly payload: string; readonly bounds: Rect };
    };

interface Fixture {
  readonly name: string;
  readonly pageMm: [number, number];
  readonly item: ItemInfo;
  readonly placement: { readonly xMm: number; readonly yMm: number; readonly rotation: Rotation };
  readonly job: JobInfo;
  readonly finishing: FinishingSpecInput;
  /** Exact plan warnings; omitted means none. */
  readonly warnings?: readonly string[];
  readonly expected: readonly { markId: string; kind: string; parts: ExpectedPart[] }[];
}

const FILE = JSON.parse(readFileSync(new URL("./fixtures/expected-marks.json", import.meta.url), "utf8")) as {
  toleranceMm: number;
  fixtures: Fixture[];
};
const TOL = FILE.toleranceMm;

function expectNear(actual: readonly number[], expected: readonly number[], what: string): void {
  expect(actual.length, `${what}: length`).toBe(expected.length);
  actual.forEach((v, i) => {
    expect(Math.abs(v - expected[i]!), `${what}[${i}] = ${v}, expected ${expected[i]}`).toBeLessThanOrEqual(TOL);
  });
}

const rectNums = (r: Rect) => [r.x, r.y, r.w, r.h];

function comparePart(actual: PartMetadata, expected: ExpectedPart, what: string): void {
  expect(actual.type, `${what}: type`).toBe(expected.type);
  if (actual.type === "lines" && expected.type === "lines") {
    expect(actual.segments).toHaveLength(expected.segments.length);
    actual.segments.forEach((s, i) => expectNear(s, expected.segments[i]!, `${what} segment ${i}`));
  } else if (actual.type === "dots" && expected.type === "dots") {
    expect(actual.diameterMm).toBeCloseTo(expected.diameterMm, 6);
    expect(actual.centers).toHaveLength(expected.centers.length);
    actual.centers.forEach((c, i) => expectNear(c, expected.centers[i]!, `${what} centre ${i}`));
  } else if (actual.type === "label" && expected.type === "label") {
    expect(actual.edge).toBe(expected.edge);
    expectNear(rectNums(actual.bounds), rectNums(expected.bounds), `${what} bounds`);
    expect(actual.code?.payload).toBe(expected.code.payload);
    expectNear(rectNums(actual.code!.bounds), rectNums(expected.code.bounds), `${what} code bounds`);
  }
}

describe("differential: /BPS_Layout mark geometry vs hand-computed fixtures", () => {
  it("has fixtures", () => {
    expect(FILE.fixtures.length).toBeGreaterThanOrEqual(2);
    expect(TOL).toBe(0.05);
  });

  it.each(FILE.fixtures.map((f) => [f.name, f] as const))("%s", async (_name, fx) => {
    const placement = placeMm(fx.item, fx.placement.xMm, fx.placement.yMm, fx.placement.rotation);
    const imp = await imposeFixture([placement], fx.pageMm[0] * PT_PER_MM, fx.pageMm[1] * PT_PER_MM, {
      originX: 0,
      originY: 0,
      scale: 1,
    });
    const { doc, ctx } = await hookContext(imp, [placement]);
    const plan = await draw(ctx, { items: [fx.item], job: fx.job, finishing: fx.finishing });
    expect(plan.warnings).toEqual(fx.warnings ?? []);

    const meta = readLayoutMetadata(await PDFDocument.load(await doc.save()))?.finishing as FinishingMetadata;
    expect(meta).toBeDefined();
    expect(meta.units).toBe("mm");
    expect(meta.elements.map((e) => e.markId).sort()).toEqual(fx.expected.map((e) => e.markId).sort());

    for (const exp of fx.expected) {
      const el = meta.elements.find((e) => e.markId === exp.markId)!;
      expect(el).toMatchObject({ id: `${fx.item.itemId}#0/${exp.markId}`, itemId: fx.item.itemId, copy: 0, page: 0, kind: exp.kind });
      expect(el.parts).toHaveLength(exp.parts.length);
      el.parts.forEach((part, i) => comparePart(part, exp.parts[i]!, `${fx.name} ${exp.markId} part ${i}`));
    }
  });
});
