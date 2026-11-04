import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { fontFixture, imageFixture, outlinedTextFixture, pageBoxesFixture } from "../src/fixtures.js";
import {
  BUILTIN_CHECKS,
  CheckRegistry,
  DEFAULT_PROFILE,
  EXAMPLE_PROFILES,
  builtinRegistry,
  defineCheck,
  evaluateChecks,
  fontsCheck,
  imageResolutionCheck,
  inspectBytes,
  loadDocumentModel,
  pageBoxesCheck,
  profileToChecks,
  resolveParams,
  validateProfile,
  type PreflightProfile,
} from "../src/index.js";

/** Spec 007 FR2: the profile schema, its justified defaults, and the severity mapping. */

function profile(checks: PreflightProfile["checks"], id = "custom"): PreflightProfile {
  return { schemaVersion: 1, id, name: "Custom", checks };
}

describe("default thresholds (FR2)", () => {
  it("effective resolution warns below 100 ppi and fails below 50 ppi", () => {
    const params = resolveParams(imageResolutionCheck, undefined);
    expect(params).toEqual({ ok: true, value: expect.objectContaining({ warnBelowPpi: 100, errorBelowPpi: 50 }) });
  });

  it("a missing font is an error and a missing TrimBox is a warning", () => {
    expect(fontsCheck.rules["not-embedded"].defaultSeverity).toBe("error");
    expect(pageBoxesCheck.rules["missing-trim-box"].defaultSeverity).toBe("warn");
  });

  it("the default profile enables every built-in check, and it and the examples validate", () => {
    expect(DEFAULT_PROFILE.checks.map((c) => c.check)).toEqual(BUILTIN_CHECKS.map((c) => c.id));
    for (const p of [DEFAULT_PROFILE, ...EXAMPLE_PROFILES]) expect(validateProfile(p), p.id).toEqual({ ok: true, value: p });
  });

  it("the default thresholds classify 120, 75 and 36 ppi as pass, warn and error", async () => {
    const severities = [];
    for (const widthPx of [120, 75, 36]) {
      const report = await inspectBytes(await imageFixture({ widthPx, heightPx: widthPx, placedWidthPt: 72, placedHeightPt: 72 }));
      severities.push(report.findings.filter((f) => f.checkId === "image-resolution").map((f) => f.severity));
    }
    expect(severities).toEqual([[], ["warn"], ["error"]]);
  });
});

describe("validateProfile", () => {
  it.each([
    [{ schemaVersion: 2, id: "x", name: "X", checks: [] }, "profile/schemaVersion"],
    [{ schemaVersion: 1, id: "Has Spaces", name: "X", checks: [] }, "profile/id"],
    [{ schemaVersion: 1, id: "x", name: "X", checks: [], extra: true }, "profile"],
    [profile([{ check: "no-such-check" }]), 'unknown check "no-such-check"'],
    [profile([{ check: "fonts" }, { check: "fonts" }]), "listed twice"],
    [profile([{ check: "fonts", severity: { "no-such-rule": "warn" } }]), 'has no rule "no-such-rule"'],
    [profile([{ check: "image-resolution", params: { warnBelowPpi: "high" } }]), "params/warnBelowPpi"],
    [profile([{ check: "image-resolution", params: { dpi: 100 } }]), 'unknown parameter "dpi"'],
  ])("rejects %j", (input, message) => {
    const result = validateProfile(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain(message);
  });

  it("checks against the registry it is given", () => {
    const empty = new CheckRegistry();
    expect(validateProfile(profile([{ check: "fonts" }]), empty).ok).toBe(false);
    expect(validateProfile(profile([{ check: "fonts" }]), builtinRegistry()).ok).toBe(true);
  });
});

describe("profileToChecks and evaluateChecks", () => {
  it("leaves out disabled checks", () => {
    const checks = profileToChecks(profile([{ check: "fonts", enabled: false }, { check: "page-boxes", severity: { "missing-trim-box": "error" } }]));
    expect(checks).toEqual({ "page-boxes": { severity: { "missing-trim-box": "error" }, params: undefined } });
  });

  it("maps rules to the profile's severities, and `off` drops a rule", async () => {
    const doc = await loadDocumentModel(await pageBoxesFixture({ mediaBox: [0, 0, 300, 300] }));
    const run = (severity?: Record<string, "info" | "warn" | "error" | "off">) =>
      evaluateChecks(doc, { "page-boxes": { severity } }).map((f) => [f.data.rule, f.severity]);
    expect(run()).toEqual([["missing-trim-box", "warn"]]);
    expect(run({ "missing-trim-box": "error" })).toEqual([["missing-trim-box", "error"]]);
    expect(run({ "missing-trim-box": "off" })).toEqual([]);
  });

  it("runs only the listed checks, and every check when none are listed", async () => {
    const doc = await loadDocumentModel(await fontFixture({ font: "unembedded" }));
    expect(new Set(evaluateChecks(doc, { fonts: {} }).map((f) => f.checkId))).toEqual(new Set(["fonts"]));
    expect(evaluateChecks(doc, {})).toEqual([]);
    expect(evaluateChecks(doc, undefined).some((f) => f.checkId === "page-boxes")).toBe(true);
  });

  it("warns about a check the inspector does not have", async () => {
    const doc = await loadDocumentModel(await outlinedTextFixture());
    expect(evaluateChecks(doc, { "remote-only": {} })).toEqual([
      expect.objectContaining({ checkId: "remote-only", severity: "warn", data: { rule: "unknown-check" } }),
    ]);
  });

  it("turns invalid parameters and a failing check into error findings", async () => {
    const doc = await loadDocumentModel(await outlinedTextFixture());
    const broken = defineCheck({
      id: "broken",
      title: "Broken",
      description: "Always throws.",
      rules: {},
      params: Type.Object({ limit: Type.Number({ default: 1 }) }),
      run: () => {
        throw new Error("boom");
      },
    });
    const registry = new CheckRegistry([broken]);
    expect(evaluateChecks(doc, { broken: {} }, registry)).toEqual([
      expect.objectContaining({ checkId: "broken", severity: "error", data: { rule: "check-failed" } }),
    ]);
    expect(evaluateChecks(doc, { broken: { params: { limit: "x" } } }, registry)).toEqual([
      expect.objectContaining({ checkId: "broken", severity: "error", data: { rule: "invalid-params" } }),
    ]);
  });

  it("refuses invalid and duplicate check ids in the registry", () => {
    const registry = builtinRegistry();
    expect(() => registry.register(fontsCheck)).toThrow(/already registered/);
    expect(() => registry.register({ ...fontsCheck, id: "Bad Id" })).toThrow(TypeError);
  });
});
