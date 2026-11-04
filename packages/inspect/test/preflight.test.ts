import { describe, expect, it } from "vitest";
import { IllegalTransitionError, withHotFolderDefaults, type JobStatus, type JobTicket } from "@bax-print/core";
import { fontFixture, outlinedTextFixture } from "../src/fixtures.js";
import type { Finding, PreflightReport } from "@bax-print/plugin-sdk";
import {
  EDIT_DEPENDENT_CHECKS,
  NotPreflightHoldError,
  OverrideReasonRequiredError,
  applyPreflightReport,
  clearPreflightHold,
  decide,
  inspectBytes,
  inspectContextOf,
  mergeReinspection,
  reinspectionChecks,
  selectProfileId,
  type PreflightJob,
} from "../src/index.js";

/** Spec 007 acceptance 2: an error finding holds the job; an audited override releases it. */

const AT = "2026-11-03T10:00:00.000Z";
const LATER = "2026-11-03T10:05:00.000Z";

function ticket(overrides: Partial<JobTicket> = {}): JobTicket {
  return { intent: { quantity: 1 }, process: {}, ...overrides };
}

function job(status: JobStatus = "inspecting", extra: Partial<PreflightJob> = {}): PreflightJob {
  return {
    id: "job-1",
    name: "fixture.pdf",
    status,
    priority: 50,
    sourceFiles: [],
    artifacts: [],
    ticket: ticket(),
    tags: [],
    metadata: {},
    createdAt: AT,
    updatedAt: AT,
    lifecycle: "active",
    legalHold: false,
    pageCount: 1,
    pages: [{ index: 0, widthPt: 300, heightPt: 100 }],
    audit: [],
    ...extra,
  };
}

function finding(checkId: string, severity: Finding["severity"], rule = "r"): Finding {
  return { checkId, severity, message: `${checkId} ${rule}`, data: { rule } };
}

function report(findings: Finding[], profileId = "default"): PreflightReport {
  const summary = { info: 0, warn: 0, error: 0 };
  findings.forEach((f) => (summary[f.severity] += 1));
  return { inspector: { id: "test", version: "1" }, profileId, generatedAt: AT, pageCount: 1, findings, summary, conformance: [] };
}

describe("preflight state (acceptance 2)", () => {
  it("a job with an error finding ends in held with reason preflight, through core's status machine", async () => {
    const inspected = await inspectBytes(await fontFixture({ font: "unembedded" }), { profileId: "default" });
    const held = applyPreflightReport(job(), inspected, { at: AT });
    expect(held.status).toBe("held");
    expect(held.updatedAt).toBe(AT);
    expect(held.hold).toMatchObject({ reason: "preflight", since: AT });
    expect(held.hold?.detail).toContain("fonts");
    expect(held.audit?.map((e) => e.type)).toEqual(["preflight.completed", "status.changed", "status.changed"]);
    expect(held.audit?.slice(1).map((e) => e.detail)).toEqual([
      { from: "inspecting", to: "ready" },
      { from: "ready", to: "held" },
    ]);
    expect(held.audit?.[0].detail).toMatchObject({ profileId: "default", summary: inspected.summary });
  });

  it("clearing the hold with a reason returns the job to ready and logs the override", async () => {
    const inspected = await inspectBytes(await fontFixture({ font: "unembedded" }));
    const held = applyPreflightReport(job(), inspected, { at: AT });
    const released = clearPreflightHold(held, { at: LATER, actor: "operator-1", reason: "  customer approved system font  " });
    expect(released.status).toBe("ready");
    expect(released.hold).toBeUndefined();
    const override = released.audit?.find((e) => e.type === "preflight.override");
    expect(override).toEqual({
      at: LATER,
      type: "preflight.override",
      actor: "operator-1",
      detail: { reason: "customer approved system font", hold: held.hold?.detail },
    });
    expect(released.audit?.at(-1)?.detail).toEqual({ from: "held", to: "ready" });
    expect(held.status).toBe("held");
  });

  it("a clean file goes to ready; warnings alone do not hold", async () => {
    const clean = applyPreflightReport(job(), await inspectBytes(await outlinedTextFixture()), { at: AT });
    expect(clean.status).toBe("ready");
    expect(clean.hold).toBeUndefined();
    expect(decide(report([finding("page-boxes", "warn"), finding("fonts", "info")]))).toEqual({ status: "ready" });
  });

  it("summarizes the errors in the hold detail", () => {
    const decision = decide(report([finding("fonts", "error"), finding("fonts", "error"), finding("page-boxes", "error")]));
    expect(decision).toEqual({ status: "held", detail: "3 preflight errors (fonts, page-boxes)" });
  });

  it("an override needs a reason, and only clears a preflight hold", () => {
    const held = applyPreflightReport(job(), report([finding("fonts", "error")]), { at: AT });
    expect(() => clearPreflightHold(held, { at: LATER, reason: "   " })).toThrow(OverrideReasonRequiredError);
    const operatorHold = job("held", { hold: { reason: "operator", since: AT } });
    expect(() => clearPreflightHold(operatorHold, { at: LATER, reason: "ok" })).toThrow(NotPreflightHoldError);
    expect(() => clearPreflightHold(job("ready"), { at: LATER, reason: "ok" })).toThrow(NotPreflightHoldError);
  });

  it("only applies a report to an inspecting job", () => {
    expect(() => applyPreflightReport(job("queued"), report([]), { at: AT })).toThrow(IllegalTransitionError);
    expect(() => applyPreflightReport(job("ready"), report([]), { at: AT })).toThrow(IllegalTransitionError);
  });
});

describe("profile selection", () => {
  it("prefers the job's ticket, then the hot folder, then the default", () => {
    const folder = { settings: { ...withHotFolderDefaults(), preflightProfileId: "vehicle-wrap" } };
    const withTicket = { ticket: ticket({ process: { preflight: { profileId: "fine-art" } } }) };
    expect(selectProfileId(withTicket, folder)).toBe("fine-art");
    expect(selectProfileId(job(), folder)).toBe("vehicle-wrap");
    expect(selectProfileId(job(), { settings: withHotFolderDefaults() })).toBe("default");
    expect(selectProfileId(job())).toBe("default");
  });

  it("passes the job's edits, printable width and cut-contour names to the inspector", () => {
    const edits = [{ kind: "rotate", degrees: 90 }];
    const withCut = ticket({ process: { cut: { spotNames: ["Contour-Cut"] } }, edits });
    expect(inspectContextOf({ ticket: withCut }, { printableWidthMm: 1600 })).toEqual({
      edits,
      printableWidthMm: 1600,
      cutSpotNames: ["Contour-Cut"],
    });
    expect(inspectContextOf(job())).toEqual({ edits: [] });
    expect(inspectContextOf({ ticket: ticket({ process: { cut: { spotNames: [1] } } }) })).toEqual({ edits: [] });
  });
});

describe("re-inspection (FR5)", () => {
  it("reruns only the size and resolution related checks", () => {
    const all = Object.fromEntries(["document", "page-boxes", "printable-width", "image-resolution", "fonts", "color-spaces"].map((id) => [id, {}]));
    expect(Object.keys(reinspectionChecks(all))).toEqual(["document", "printable-width", "image-resolution", "color-spaces"]);
    expect(EDIT_DEPENDENT_CHECKS).toContain("image-resolution");
    expect(EDIT_DEPENDENT_CHECKS).toContain("printable-width");
  });

  it("replaces the findings of the rerun checks and keeps the others, in check order", () => {
    const previous = report([finding("page-boxes", "warn", "missing-trim-box"), finding("image-resolution", "warn", "old"), finding("fonts", "error")]);
    const rerun = { ...report([finding("image-resolution", "error", "new")]), profileId: undefined, generatedAt: LATER };
    const merged = mergeReinspection(previous, rerun, ["image-resolution", "printable-width"]);
    expect(merged.findings.map((f) => [f.checkId, f.data.rule])).toEqual([
      ["page-boxes", "missing-trim-box"],
      ["image-resolution", "new"],
      ["fonts", "r"],
    ]);
    expect(merged.summary).toEqual({ info: 0, warn: 1, error: 2 });
    expect(merged.profileId).toBe("default");
    expect(merged.generatedAt).toBe(LATER);
  });
});
