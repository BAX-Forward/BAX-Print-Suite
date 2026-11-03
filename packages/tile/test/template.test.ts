import { describe, expect, it } from "vitest";
import {
  parseTileTemplate,
  serializeTileTemplate,
  specFromTemplate,
  templateFromSpec,
  tile,
  TILE_TEMPLATE_KIND,
  TILE_TEMPLATE_VERSION,
  type TileSpec,
  type TileTemplate,
} from "../src/index.js";

const page = { widthMm: 3000, heightMm: 2000 };

const spec: TileSpec = {
  grid: { mode: "size", maxWidthMm: 1300 },
  seamsX: [750, 1500, 2250],
  accounting: "visible",
  seam: { kind: "overlap", overlapMm: 30 },
  seamTreatmentsX: [null, { kind: "butt" }],
  bleedMm: 3,
  naming: { rows: "numbers", cols: "numbers", separator: "/" },
};

function parsed(input: unknown): TileTemplate {
  const result = parseTileTemplate(input);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.template;
}

describe("FR9 tile templates", () => {
  it("round-trips an absolute template through JSON", () => {
    const template = templateFromSpec(spec, { name: "Wall 3 m", positioning: "absolute" });
    const json = serializeTileTemplate(template);

    expect(json.endsWith("\n")).toBe(true);
    const back = parsed(json);
    expect(back).toEqual(template);
    expect(back).toMatchObject({ kind: TILE_TEMPLATE_KIND, version: TILE_TEMPLATE_VERSION, positioning: "absolute" });
    expect(specFromTemplate(back, page)).toEqual(spec);
  });

  it("stores relative seams as fractions and scales them to new artwork", () => {
    const template = templateFromSpec(spec, { name: "Quarters", positioning: "relative", page });
    expect(template.seamsX).toEqual([0.25, 0.5, 0.75]);

    const wider = { widthMm: 4000, heightMm: 1000 };
    const applied = specFromTemplate(parsed(serializeTileTemplate(template)), wider);
    expect(applied.seamsX).toEqual([1000, 2000, 3000]);
    // Physical values stay in mm.
    expect(applied.seam).toEqual({ kind: "overlap", overlapMm: 30 });
    expect(applied.bleedMm).toBe(3);

    const result = tile(wider, { ...applied, grid: { mode: "count", columns: 1, rows: 1 } });
    expect(result.ok).toBe(true);
    expect(result.panels.map((p) => p.label)).toEqual(["1/1", "1/2", "1/3", "1/4"]);
  });

  it("copies rather than aliases the spec", () => {
    const template = templateFromSpec(spec, { name: "Copy", positioning: "absolute" });
    (template.seam as { overlapMm: number }).overlapMm = 99;
    expect(spec.seam).toEqual({ kind: "overlap", overlapMm: 30 });
  });

  it("keeps null slots in per-seam treatments and drops unknown fields", () => {
    const template = parsed({
      kind: TILE_TEMPLATE_KIND,
      version: TILE_TEMPLATE_VERSION,
      name: "Count",
      positioning: "absolute",
      grid: { mode: "count", columns: 4, rows: 2 },
      seamTreatmentsY: [null],
      extra: "ignored",
    });
    expect(template.seamTreatmentsY).toEqual([null]);
    expect("extra" in template).toBe(false);
  });

  it("rejects malformed templates with readable errors", () => {
    const valid = templateFromSpec(spec, { name: "Ok", positioning: "relative", page });
    const cases: [unknown, RegExp][] = [
      ["{ not json", /not valid JSON/],
      [[], /JSON object/],
      [{ ...valid, kind: "other" }, /kind/],
      [{ ...valid, version: 2 }, /version/],
      [{ ...valid, name: " " }, /name/],
      [{ ...valid, positioning: "pixels" }, /positioning/],
      [{ ...valid, seamsX: [0.5, 1.2] }, /strictly between 0 and 1/],
      [{ ...valid, seamsX: [0.6, 0.4] }, /strictly increasing/],
      [{ ...valid, grid: { mode: "count", columns: 0, rows: 1 } }, /grid.columns/],
      [{ ...valid, grid: { mode: "size", maxWidthMm: -5 } }, /grid.maxWidthMm/],
      [{ ...valid, seam: { kind: "gap", gapMm: 0 } }, /gapMm/],
      [{ ...valid, seamTreatmentsX: [{ kind: "glue" }] }, /seamTreatmentsX\[0\]/],
      [{ ...valid, bleedMm: -1 }, /bleedMm/],
      [{ ...valid, naming: { rows: "roman" } }, /naming/],
      [{ ...valid, accounting: "both" }, /accounting/],
    ];
    for (const [input, message] of cases) {
      const result = parseTileTemplate(input);
      expect(result.ok, String(message)).toBe(false);
      expect(!result.ok && result.errors.join("; ")).toMatch(message);
    }
  });
});
