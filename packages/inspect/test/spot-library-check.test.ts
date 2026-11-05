import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import type { JobEdit } from "@bax-print/core";
import { separationFixture } from "../src/fixtures.js";
import { colorSpacesCheck, loadDocumentModel, spotNameKey, type PreflightContext, type RawFinding } from "../src/index.js";

/** Spec 010b: spot colorants that are not in the shop's spot library. */

async function run(bytes: Uint8Array, context: PreflightContext = {}, params: Record<string, unknown> = {}): Promise<RawFinding[]> {
  const doc = await loadDocumentModel(bytes, context);
  return colorSpacesCheck.run(doc, Value.Parse(colorSpacesCheck.params, structuredClone(params)));
}

function missing(findings: readonly RawFinding[]): RawFinding[] {
  return findings.filter((f) => f.rule === "spot-not-in-library");
}

describe("spotNameKey", () => {
  // Expected values follow media's normalizeSpotName (NFC, collapse whitespace, trim, lower case);
  // inspect has no dependency on media, so they are written out here.
  it.each([
    ["Spot A", "spot a"],
    ["  Deep   Blue ", "deep blue"],
    ["Warm\tRed", "warm red"],
    ["CUTCONTOUR", "cutcontour"],
    ["Line\nBreak  Ink", "line break ink"],
    ["Café Brown", "café brown"],
  ])("%j has the key %j", (name, key) => {
    expect(spotNameKey(name)).toBe(key);
  });
});

describe("color-spaces spot library check", () => {
  it("reports nothing for a colorant in the library", async () => {
    const findings = await run(await separationFixture({ colorant: "Spot A" }), {}, { librarySpotNames: ["Spot A", "Spot C"] });
    expect(missing(findings)).toEqual([]);
  });

  it("warns about a colorant not in the library, after the existing findings", async () => {
    const bytes = await separationFixture({ colorant: "Spot A" });
    const before = await run(bytes);
    const findings = await run(bytes, {}, { librarySpotNames: ["Spot C"] });
    expect(findings.slice(0, before.length)).toEqual(before);
    expect(findings.slice(before.length)).toEqual([
      {
        rule: "spot-not-in-library",
        page: 0,
        message: 'Spot colorant "Spot A" is not in the spot library; used on page 1',
        data: { colorant: "Spot A", effectiveName: "Spot A", pages: [0] },
      },
    ]);
    expect(colorSpacesCheck.rules["spot-not-in-library"]?.defaultSeverity).toBe("warn");
  });

  it("matches names ignoring case and whitespace differences", async () => {
    const bytes = await separationFixture({ colorant: "Spot A", space: "devicen" });
    expect(missing(await run(bytes, {}, { librarySpotNames: ["  spot   a ", "SPOT\tB"] }))).toEqual([]);
    expect(missing(await run(bytes, {}, { librarySpotNames: ["spot a"] })).map((f) => f.data?.colorant)).toEqual(["Spot B"]);
  });

  it("judges a colorant by its spotMap target", async () => {
    const bytes = await separationFixture({ colorant: "Contour" });
    const toSpot: JobEdit[] = [{ kind: "spotMap", from: "Contour", to: { kind: "colorant", name: "Spot A" } }];
    expect(missing(await run(bytes, { edits: toSpot }, { librarySpotNames: ["Spot A"] }))).toEqual([]);
    const flagged = missing(await run(bytes, { edits: toSpot }, { librarySpotNames: ["Contour"] }));
    expect(flagged.map((f) => f.data)).toEqual([{ colorant: "Contour", effectiveName: "Spot A", pages: [0] }]);
    const toProcess: JobEdit[] = [{ kind: "spotMap", from: "Contour", to: { kind: "process" } }];
    expect(missing(await run(bytes, { edits: toProcess }, { librarySpotNames: ["Spot A"] }))).toEqual([]);
  });

  it("never flags a cut-contour colorant", async () => {
    const library = { librarySpotNames: ["Spot A"] };
    expect(missing(await run(await separationFixture(), { cutSpotNames: ["CutContourTest"] }, library))).toEqual([]);
    expect(missing(await run(await separationFixture(), {}, { ...library, cutSpotNames: ["CutContourTest"] }))).toEqual([]);
    const devicen = missing(await run(await separationFixture({ space: "devicen" }), { cutSpotNames: ["CutContourTest"] }, library));
    expect(devicen.map((f) => f.data?.colorant)).toEqual(["Spot B"]);
  });

  it("an empty library adds no findings", async () => {
    const bytes = await separationFixture({ space: "devicen" });
    const findings = await run(bytes, {}, { librarySpotNames: [] });
    expect(missing(findings)).toEqual([]);
    expect(findings).toEqual(await run(bytes));
  });
});
