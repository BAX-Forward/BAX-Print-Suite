import { describe, expect, it } from "vitest";
import { withStatus, type Job, type JobStatus } from "../src/index.js";

const AT = "2026-11-03T10:00:00.000Z";
const LATER = "2026-11-03T10:05:00.000Z";

function job(status: JobStatus): Job {
  return {
    id: "job-1",
    name: "fixture",
    status,
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
  };
}

describe("job status machine, Spec 007 preflight path", () => {
  it("walks received → inspecting → ready → held → queued", () => {
    let current = job("received");
    for (const to of ["inspecting", "ready", "held", "queued"] as const) {
      current = withStatus(current, to, LATER);
      expect(current.status).toBe(to);
    }
  });

  it("releases a hold to ready (Spec 007)", () => {
    const released = withStatus(job("held"), "ready", LATER);
    expect(released.status).toBe("ready");
    expect(released.updatedAt).toBe(LATER);
  });

  it("does not mutate the input job", () => {
    const original = job("received");
    withStatus(original, "inspecting", LATER);
    expect(original.status).toBe("received");
    expect(original.updatedAt).toBe(AT);
  });
});
