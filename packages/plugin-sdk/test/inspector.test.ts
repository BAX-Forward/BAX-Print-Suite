import { PassThrough } from "node:stream";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  FindingSchema,
  InspectRequestSchema,
  PreflightReportSchema,
  RemoteInspector,
  serveInspector,
  summarize,
  type Finding,
  type FixupRequest,
  type FixupResult,
  type InspectRequest,
  type Inspector,
  type PreflightReport,
} from "../src/index.js";

/** Spec 007: the Inspector/1 findings schema and the fixup() handle, over BPP. */

const FINDINGS: Finding[] = [
  { checkId: "fonts", severity: "error", page: 0, objectRef: "7 0 R", message: "Font not embedded", data: { rule: "not-embedded" } },
  { checkId: "page-boxes", severity: "warn", page: 0, message: "No TrimBox", data: { rule: "missing-trim-box" } },
];

class FakeInspector implements Inspector {
  readonly id = "org.example.fake-inspector";
  readonly version = "1.0.0";
  readonly fixupTargets = ["PDF/X-4"];
  requests: InspectRequest[] = [];

  async inspect(request: InspectRequest): Promise<PreflightReport> {
    this.requests.push(request);
    return {
      inspector: { id: this.id, version: this.version },
      ...(request.profileId !== undefined ? { profileId: request.profileId } : {}),
      generatedAt: "2026-11-03T10:00:00.000Z",
      pageCount: 1,
      findings: FINDINGS,
      summary: summarize(FINDINGS),
      conformance: [],
    };
  }

  async fixup(request: FixupRequest): Promise<FixupResult> {
    return { document: { kind: "file", path: `${request.outputDir}/fixed.pdf` }, target: request.target, log: ["converted"] };
  }
}

async function connected(inspector: Inspector): Promise<RemoteInspector> {
  const toPlugin = new PassThrough();
  const toHost = new PassThrough();
  serveInspector(inspector, { input: toPlugin, output: toHost, onExit: () => {} });
  return RemoteInspector.connect(toHost, toPlugin);
}

const DOCUMENT = { kind: "file" as const, path: "/spool/job-1.pdf" };

describe("Inspector/1 schemas", () => {
  it("accepts well-formed findings and rejects bad severities", () => {
    for (const finding of FINDINGS) expect(Value.Check(FindingSchema, finding)).toBe(true);
    expect(Value.Check(FindingSchema, { ...FINDINGS[0], severity: "fatal" })).toBe(false);
    expect(Value.Check(InspectRequestSchema, { document: { kind: "url", path: "x" } })).toBe(false);
  });

  it("summarizes findings by severity", () => {
    expect(summarize(FINDINGS)).toEqual({ info: 0, warn: 1, error: 1 });
  });
});

describe("Inspector/1 over BPP", () => {
  it("inspects by handle and validates the report", async () => {
    const plugin = new FakeInspector();
    const remote = await connected(plugin);
    expect(remote.id).toBe(plugin.id);
    expect(remote.fixupTargets).toEqual(["PDF/X-4"]);
    const report = await remote.inspect({ document: DOCUMENT, profileId: "default", checks: { fonts: {} } });
    expect(Value.Check(PreflightReportSchema, report)).toBe(true);
    expect(report.findings).toEqual(FINDINGS);
    expect(plugin.requests[0]?.document).toEqual(DOCUMENT);
    await remote.close();
  });

  it("fixup() returns a handle to a new file, and refuses unknown targets", async () => {
    const remote = await connected(new FakeInspector());
    const result = await remote.fixup({ document: DOCUMENT, target: "PDF/X-4", outputDir: "/spool/out" });
    expect(result).toEqual({ document: { kind: "file", path: "/spool/out/fixed.pdf" }, target: "PDF/X-4", log: ["converted"] });
    await expect(remote.fixup({ document: DOCUMENT, target: "PDF/A-1b", outputDir: "/spool/out" })).rejects.toThrow(/not supported/);
    await remote.close();
  });

  it("rejects an invalid request on the plugin side", async () => {
    const remote = await connected(new FakeInspector());
    await expect(remote.inspect({ document: { kind: "file", path: "" } })).rejects.toThrow(/invalid inspect request/);
    await remote.close();
  });
});
