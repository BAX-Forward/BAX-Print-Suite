import { describe, expect, it } from "vitest";
import type { Hold } from "../src/hold.js";
import { isHoldReason } from "../src/hold.js";
import { ARTIFACT_ROLES, type Job, type JobArtifact } from "../src/job.js";
import { withHotFolderDefaults } from "../src/types.js";

const AT = "2026-11-04T09:00:00.000Z";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    name: "fixture",
    status: "received",
    priority: 50,
    sourceFiles: [{ name: "fixture.pdf", sha256: "0".repeat(64), sizeBytes: 16, storageKey: "jobs/job-1/source/0-fixture.pdf" }],
    artifacts: [],
    ticket: { intent: { quantity: 1 }, process: {} },
    tags: [],
    metadata: {},
    createdAt: AT,
    updatedAt: AT,
    lifecycle: "active",
    legalHold: false,
    ...overrides,
  };
}

describe("Job, Spec 007 core additions", () => {
  it("has no hold unless one is set", () => {
    expect(job().hold).toBeUndefined();
  });

  it("carries an optional preflight hold that survives a JSON round trip", () => {
    const hold: Hold = { reason: "preflight", since: AT, detail: "1 preflight error (image-resolution)" };
    const held = job({ status: "held", hold });
    const restored = JSON.parse(JSON.stringify(held)) as Job;
    expect(restored.hold).toEqual(hold);
    expect(isHoldReason(restored.hold?.reason)).toBe(true);
    expect(isHoldReason("someone")).toBe(false);
  });

  it("accepts normalized artifacts (FR3) next to layout, cut and preview", () => {
    expect(ARTIFACT_ROLES).toEqual(["layout", "cut", "preview", "normalized"]);
    const normalized: JobArtifact = { role: "normalized", name: "fixture-pdfx4.pdf", sha256: "1".repeat(64), sizeBytes: 32, storageKey: "jobs/job-1/normalized/0" };
    expect(job({ artifacts: [normalized] }).artifacts[0]?.role).toBe("normalized");
  });

  it("keeps a hot folder's preflight profile binding through the settings defaults", () => {
    expect(withHotFolderDefaults({ preflightProfileId: "vehicle-wrap" }).preflightProfileId).toBe("vehicle-wrap");
    expect(withHotFolderDefaults()).not.toHaveProperty("preflightProfileId");
  });
});
