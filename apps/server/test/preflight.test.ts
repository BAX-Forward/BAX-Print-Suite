import type { JobTicket } from "@bax-print/core";
import { EventBus, MemoryOutbox } from "@bax-print/events";
import { summarize, type Finding, type InspectRequest, type Inspector, type PreflightReport } from "@bax-print/plugin-sdk";
import { MemoryJobRepository, MemoryStorage } from "@bax-print/store";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/errors.js";
import { JobService, type JobServiceDeps } from "../src/jobs.js";
import { PreflightService } from "../src/preflight-service.js";
import { ProfileService } from "../src/profiles.js";
import { MemoryFindingsStore, MemoryProfileStore } from "../src/stores.js";
import { fakeClock, sequentialIds } from "./helpers.js";

const AT = "2026-11-04T09:00:00.000Z";
const MIN_PPI = 300;
/** 150 px drawn across one inch (72 pt): 150 ppi before edits. */
const IMAGE = { pixelWidth: 150, pixelHeight: 150, ctm: [72, 0, 0, 72, 10, 10] };
const PAGE_BOX = [0, 0, 200, 200];
const OPERATOR = { id: "operator-1", role: "admin" } as const;
const TICKET: JobTicket = { intent: { quantity: 1 }, process: {} };

/** Reports one source-space resolution finding under the resolution check it was asked to run. */
class FakeInspector implements Inspector {
  readonly id = "org.bax-print.test.fake";
  readonly version = "0.0.0";
  requests: InspectRequest[] = [];

  async inspect(request: InspectRequest): Promise<PreflightReport> {
    this.requests.push(request);
    const ids = Object.keys(request.checks ?? {});
    const checkId = ids.find((id) => /resolution|ppi/i.test(id)) ?? ids[0] ?? "image-resolution";
    const findings: Finding[] = [
      {
        checkId,
        severity: "error",
        message: "Image resolution is 150 ppi, below the 300 ppi minimum",
        data: { pageIndex: 0, pageBox: PAGE_BOX, minPpi: MIN_PPI, image: IMAGE },
      },
    ];
    return {
      inspector: { id: this.id, version: this.version },
      profileId: request.profileId,
      generatedAt: AT,
      pageCount: 1,
      findings,
      summary: summarize(findings),
      conformance: [],
    };
  }
}

async function setup() {
  const time = fakeClock(AT);
  const bus = new EventBus(new MemoryOutbox(), { clock: time.clock, newId: sequentialIds("evt") });
  const publish = vi.spyOn(bus, "publish");
  const repository = new MemoryJobRepository();
  const jobService = new JobService({ jobs: repository, blobs: new MemoryStorage(), bus, clock: time.clock, newId: sequentialIds("job") });
  const inspector = new FakeInspector();
  const service = new PreflightService({
    jobs: repository,
    findings: new MemoryFindingsStore(),
    profiles: new ProfileService(new MemoryProfileStore()),
    events: jobService,
    inspector,
    blobPath: (key) => `/blobs/${key}`,
    spoolDir: "/spool",
    now: time.clock,
  });
  const created = await jobService.create({
    name: "fixture",
    sources: [{ name: "fixture.pdf", bytes: Buffer.from("%PDF-1.7 fixture") }],
    ticket: TICKET,
  });
  const actions = () =>
    publish.mock.calls.map(([event]) => event.data as { action?: string; details?: Record<string, unknown> }).filter((d) => d.action);
  return { id: created.id, repository, inspector, service, actions };
}

describe("preflight hold and override (Spec 007 test 2)", () => {
  it("holds a job with an error finding for preflight", async () => {
    const { id, service, inspector } = await setup();
    const job = await service.inspectJob(id, OPERATOR);
    expect(job.status).toBe("held");
    expect(job.hold?.reason).toBe("preflight");
    expect(inspector.requests[0]?.document).toEqual({ kind: "file", path: `/blobs/${job.sourceFiles[0]?.storageKey}` });
    const view = await service.findings(id);
    expect(view.report?.findings).toHaveLength(1);
  });

  it("clears the hold with the reason published as an audit event", async () => {
    const { id, service, repository, actions } = await setup();
    await service.inspectJob(id);
    const cleared = await service.clearHold(id, "Customer accepted low resolution", OPERATOR);
    expect(cleared.status).toBe("ready");
    expect(cleared.hold).toBeUndefined();
    expect((await repository.get(id))?.status).toBe(cleared.status);
    const override = actions().find((d) => d.action === "preflight.override");
    expect(override?.details).toMatchObject({ reason: "Customer accepted low resolution" });
  });

  it("refuses an override without a reason", async () => {
    const { id, service } = await setup();
    await service.inspectJob(id);
    await expect(service.clearHold(id, "  ")).rejects.toBeInstanceOf(HttpError);
  });

  it("refuses an override on a job that is not held by preflight", async () => {
    const { id, service } = await setup();
    const error = await service.clearHold(id, "reason").catch((e: unknown) => e);
    expect((error as HttpError).statusCode).toBe(409);
  });
});

describe("PATCH edits (Spec 007 test 5)", () => {
  it("stores the edits on the ticket and reruns the checks", async () => {
    const { id, service, repository, inspector } = await setup();
    await service.inspectJob(id);
    const edits = [{ kind: "rotate", degrees: 90 }, { kind: "scale", percent: 50 }];
    const { job } = await service.updateEdits(id, edits, OPERATOR);
    expect(job.ticket.edits).toEqual(edits);
    expect((await repository.get(id))?.ticket.edits).toEqual(edits);
    expect(inspector.requests).toHaveLength(2);
    expect(Object.keys(inspector.requests[1]?.checks ?? {})).toContain("image-resolution");
  });

  it("drops the ppi finding once a scale-down edit reaches the minimum", async () => {
    const { id, service } = await setup();
    const held = await service.inspectJob(id);
    expect(held.status).toBe("held");
    const { job, report } = await service.updateEdits(id, [{ kind: "scale", percent: 50 }]);
    expect(report?.findings).toHaveLength(0);
    expect(job.status).toBe("ready");
    expect(job.hold).toBeUndefined();
  });

  it("reports the edited resolution after a scale-up edit", async () => {
    const { id, service } = await setup();
    await service.inspectJob(id);
    const { job, report } = await service.updateEdits(id, [{ kind: "scale", percent: 200 }]);
    expect(job.status).toBe("held");
    expect(report?.findings).toHaveLength(1);
    expect(report?.findings[0]?.message).toContain("75 ppi");
    expect(report?.findings[0]?.data).toMatchObject({ effectivePpi: 75, editsApplied: true });
  });

  it("stores edits on a job not inspected yet without running checks", async () => {
    const { id, service, inspector } = await setup();
    const { job, report } = await service.updateEdits(id, [{ kind: "mirror" }]);
    expect(job.status).toBe("received");
    expect(report).toBeNull();
    expect(inspector.requests).toHaveLength(0);
  });

  it("rejects invalid edits with a 400 and keeps the stored ticket", async () => {
    const { id, service, repository } = await setup();
    const error = await service.updateEdits(id, [{ kind: "rotate", degrees: 45 }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(400);
    expect((await repository.get(id))?.ticket.edits).toBeUndefined();
  });
});

describe("layout input", () => {
  const service = new JobService({} as JobServiceDeps);
  const item = { id: "item-1", widthPt: 200, heightPt: 100, quantity: 1, rotation: "none" as const };

  function jobWith(ticket: JobTicket): Parameters<JobService["layoutItems"]>[0] {
    return { id: "job-1", ticket } as unknown as Parameters<JobService["layoutItems"]>[0];
  }

  it("leaves items unchanged without edits", () => {
    const [laid] = service.layoutItems(jobWith(TICKET), [item]);
    expect(laid).toMatchObject({ widthPt: 200, heightPt: 100, jobId: "job-1" });
  });

  it("reflects rotate and scale in the item footprint", () => {
    const ticket: JobTicket = {
      ...TICKET,
      edits: [{ kind: "rotate", degrees: 90 }, { kind: "scale", percent: 50 }, { kind: "copies", count: 3 }],
    };
    const [laid] = service.layoutItems(jobWith(ticket), [item]);
    expect(laid?.widthPt).toBeCloseTo(50, 9);
    expect(laid?.heightPt).toBeCloseTo(100, 9);
    expect(laid?.quantity).toBe(3);
  });
});
