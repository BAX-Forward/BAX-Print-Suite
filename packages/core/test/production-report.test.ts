import { describe, expect, it } from "vitest";
import {
  InvalidArgumentError,
  productionReport,
  productionReportToCsv,
  type JobProductionRecord,
  type ProductionReportOptions,
} from "../src/index.js";

const HOUR = 3_600_000;

const period: Omit<ProductionReportOptions, "groupBy"> = { from: "2026-03-01T00:00:00Z", to: "2026-03-03T00:00:00Z" };

const records: readonly JobProductionRecord[] = [
  // Received on the inclusive start; done after 2 h.
  {
    jobId: "j1",
    status: "done",
    customer: "Acme",
    deviceId: "dev-a",
    receivedAt: "2026-03-01T00:00:00Z",
    finishedAt: "2026-03-01T02:00:00Z",
  },
  // Received before the window, done inside it after 24 h.
  {
    jobId: "j2",
    status: "done",
    customer: "Acme",
    deviceId: "dev-b",
    receivedAt: "2026-02-28T23:00:00Z",
    finishedAt: "2026-03-01T23:00:00Z",
  },
  { jobId: "j3", status: "failed", deviceId: "dev-a", receivedAt: "2026-03-02T08:00:00Z", finishedAt: "2026-03-02T09:00:00Z" },
  // Cancelled on the exclusive end: received counts, the cancellation does not.
  { jobId: "j4", status: "cancelled", customer: "Beta", receivedAt: "2026-03-02T10:00:00Z", finishedAt: "2026-03-03T00:00:00Z" },
  { jobId: "j5", status: "processing", customer: "Beta", deviceId: "dev-a", receivedAt: "2026-03-02T12:00:00Z" },
  // Entirely before the window.
  {
    jobId: "j6",
    status: "done",
    customer: "Acme",
    deviceId: "dev-a",
    receivedAt: "2026-02-27T00:00:00Z",
    finishedAt: "2026-02-28T23:59:59Z",
  },
  {
    jobId: "j7",
    status: "done",
    customer: "Beta",
    deviceId: "dev-b",
    receivedAt: "2026-03-02T00:00:00Z",
    finishedAt: "2026-03-02T04:00:00Z",
  },
];

// Turnarounds in the window: 2 h, 4 h, 24 h.
const expectedTotals = {
  jobsReceived: 5,
  jobsCompleted: 3,
  jobsFailedOrCancelled: 1,
  medianTurnaroundMs: 4 * HOUR,
  p90TurnaroundMs: 20 * HOUR,
};

describe("productionReport groupBy", () => {
  it("groups by customer with missing customers as unassigned", () => {
    const report = productionReport(records, { ...period, groupBy: "customer" });
    expect(report.groups).toEqual([
      {
        key: "Acme",
        jobsReceived: 1,
        jobsCompleted: 2,
        jobsFailedOrCancelled: 0,
        medianTurnaroundMs: 13 * HOUR,
        p90TurnaroundMs: 78_480_000,
      },
      {
        key: "Beta",
        jobsReceived: 3,
        jobsCompleted: 1,
        jobsFailedOrCancelled: 0,
        medianTurnaroundMs: 4 * HOUR,
        p90TurnaroundMs: 4 * HOUR,
      },
      {
        key: "unassigned",
        jobsReceived: 1,
        jobsCompleted: 0,
        jobsFailedOrCancelled: 1,
        medianTurnaroundMs: null,
        p90TurnaroundMs: null,
      },
    ]);
    expect(report.totals).toEqual(expectedTotals);
    expect(report.from).toBe(period.from);
    expect(report.to).toBe(period.to);
  });

  it("groups by device with missing devices as unassigned", () => {
    const report = productionReport(records, { ...period, groupBy: "device" });
    expect(report.groups).toEqual([
      {
        key: "dev-a",
        jobsReceived: 3,
        jobsCompleted: 1,
        jobsFailedOrCancelled: 1,
        medianTurnaroundMs: 2 * HOUR,
        p90TurnaroundMs: 2 * HOUR,
      },
      {
        key: "dev-b",
        jobsReceived: 1,
        jobsCompleted: 2,
        jobsFailedOrCancelled: 0,
        medianTurnaroundMs: 14 * HOUR,
        p90TurnaroundMs: 22 * HOUR,
      },
      {
        key: "unassigned",
        jobsReceived: 1,
        jobsCompleted: 0,
        jobsFailedOrCancelled: 0,
        medianTurnaroundMs: null,
        p90TurnaroundMs: null,
      },
    ]);
    expect(report.totals).toEqual(expectedTotals);
  });

  it("groups by the UTC day each event happened, in date order", () => {
    const report = productionReport(records, { ...period, groupBy: "day" });
    expect(report.groups).toEqual([
      {
        key: "2026-03-01",
        jobsReceived: 1,
        jobsCompleted: 2,
        jobsFailedOrCancelled: 0,
        medianTurnaroundMs: 13 * HOUR,
        p90TurnaroundMs: 78_480_000,
      },
      {
        key: "2026-03-02",
        jobsReceived: 4,
        jobsCompleted: 1,
        jobsFailedOrCancelled: 1,
        medianTurnaroundMs: 4 * HOUR,
        p90TurnaroundMs: 4 * HOUR,
      },
    ]);
    expect(report.totals).toEqual(expectedTotals);
  });

  it("puts every job in one group when not grouped", () => {
    const report = productionReport(records, { ...period, groupBy: "none" });
    expect(report.groups).toEqual([{ key: "all", ...expectedTotals }]);
  });

  it("does not depend on record order", () => {
    for (const groupBy of ["customer", "device", "day", "none"] as const) {
      expect(productionReport([...records].reverse(), { ...period, groupBy })).toEqual(
        productionReport(records, { ...period, groupBy }),
      );
    }
  });

  it("treats a blank customer as unassigned", () => {
    const report = productionReport([{ jobId: "j", status: "received", customer: " ", receivedAt: "2026-03-01T08:00:00Z" }], {
      ...period,
      groupBy: "customer",
    });
    expect(report.groups.map((group) => group.key)).toEqual(["unassigned"]);
  });
});

describe("productionReport window boundaries", () => {
  it("includes from, excludes to, and counts each event by its own timestamp", () => {
    const report = productionReport(
      [
        { jobId: "at-from", status: "done", receivedAt: period.from, finishedAt: period.from },
        { jobId: "last-ms", status: "done", receivedAt: "2026-03-02T23:00:00Z", finishedAt: "2026-03-02T23:59:59.999Z" },
        { jobId: "done-at-to", status: "done", receivedAt: "2026-03-02T22:00:00Z", finishedAt: period.to },
        { jobId: "received-at-to", status: "received", receivedAt: period.to },
        { jobId: "before", status: "failed", receivedAt: "2026-02-28T00:00:00Z", finishedAt: "2026-02-28T23:59:59.999Z" },
      ],
      { ...period, groupBy: "none" },
    );
    // Turnarounds 0 and 3 599 999 ms: median 1 799 999.5 rounds up, p90 3 239 999.1 rounds down.
    expect(report.totals).toEqual({
      jobsReceived: 3,
      jobsCompleted: 2,
      jobsFailedOrCancelled: 0,
      medianTurnaroundMs: 1_800_000,
      p90TurnaroundMs: 3_239_999,
    });
  });
});

describe("productionReport percentiles", () => {
  function doneJobs(turnaroundsMs: readonly number[]): JobProductionRecord[] {
    const receivedMs = Date.parse("2026-03-01T00:00:00Z");
    return turnaroundsMs.map((ms, i): JobProductionRecord => ({
      jobId: `t${i}`,
      status: "done",
      receivedAt: new Date(receivedMs).toISOString(),
      finishedAt: new Date(receivedMs + ms).toISOString(),
    }));
  }

  it("uses the single value for median and p90 of one job", () => {
    const report = productionReport(doneJobs([5000]), { ...period, groupBy: "none" });
    expect(report.totals.medianTurnaroundMs).toBe(5000);
    expect(report.totals.p90TurnaroundMs).toBe(5000);
  });

  it("interpolates between closest ranks for an even count, regardless of input order", () => {
    const report = productionReport(doneJobs([10_000, 2000, 1000, 4000]), { ...period, groupBy: "none" });
    expect(report.totals.medianTurnaroundMs).toBe(3000);
    expect(report.totals.p90TurnaroundMs).toBe(8200);
  });

  it("averages the two values of a two-job sample and rounds to whole milliseconds", () => {
    const report = productionReport(doneJobs([1000, 2001]), { ...period, groupBy: "none" });
    expect(report.totals.medianTurnaroundMs).toBe(1501);
    expect(report.totals.p90TurnaroundMs).toBe(1901);
  });

  it("ignores failed and cancelled jobs for turnaround", () => {
    const report = productionReport(
      [
        ...doneJobs([1000]),
        { jobId: "f", status: "failed", receivedAt: "2026-03-01T00:00:00Z", finishedAt: "2026-03-01T05:00:00Z" },
        { jobId: "c", status: "cancelled", receivedAt: "2026-03-01T00:00:00Z", finishedAt: "2026-03-01T06:00:00Z" },
      ],
      { ...period, groupBy: "none" },
    );
    expect(report.totals).toEqual({
      jobsReceived: 3,
      jobsCompleted: 1,
      jobsFailedOrCancelled: 2,
      medianTurnaroundMs: 1000,
      p90TurnaroundMs: 1000,
    });
  });
});

describe("productionReport empty input", () => {
  it("returns no groups, zero counts and null turnarounds", () => {
    for (const groupBy of ["customer", "device", "day", "none"] as const) {
      const report = productionReport([], { ...period, groupBy });
      expect(report.groups).toEqual([]);
      expect(report.totals).toEqual({
        jobsReceived: 0,
        jobsCompleted: 0,
        jobsFailedOrCancelled: 0,
        medianTurnaroundMs: null,
        p90TurnaroundMs: null,
      });
    }
  });

  it("returns no groups when no record falls in the window", () => {
    const report = productionReport(records, { from: "2027-01-01T00:00:00Z", to: "2027-02-01T00:00:00Z", groupBy: "day" });
    expect(report.groups).toEqual([]);
    expect(report.totals.jobsReceived).toBe(0);
  });
});

describe("productionReport validation", () => {
  it.each([
    [{ from: "2026-03-01", to: period.to }, "from"],
    [{ from: period.from, to: "2026-03-03T00:00:00+01:00" }, "to"],
    [{ from: "2026-02-30T00:00:00Z", to: period.to }, "from"],
    [{ from: period.to, to: period.from }, "earlier than"],
    [{ from: period.from, to: period.from }, "earlier than"],
  ])("rejects period %j", (bounds, message) => {
    expect(() => productionReport([], { ...bounds, groupBy: "none" })).toThrow(InvalidArgumentError);
    expect(() => productionReport([], { ...bounds, groupBy: "none" })).toThrow(message);
  });

  it.each<[JobProductionRecord, string]>([
    [{ jobId: "", status: "received", receivedAt: period.from }, "records[0].jobId"],
    [{ jobId: "a", status: "received", receivedAt: "yesterday" }, "records[0].receivedAt"],
    [{ jobId: "a", status: "done", receivedAt: period.from }, "finishedAt is required"],
    [{ jobId: "a", status: "queued", receivedAt: period.from, finishedAt: period.from }, "not final"],
    [{ jobId: "a", status: "done", receivedAt: period.from, finishedAt: "2026-02-30T00:00:00Z" }, "records[0].finishedAt"],
    [{ jobId: "a", status: "failed", receivedAt: "2026-03-01T02:00:00Z", finishedAt: "2026-03-01T01:00:00Z" }, "earlier than"],
  ])("rejects record %j", (record, message) => {
    expect(() => productionReport([record], { ...period, groupBy: "none" })).toThrow(InvalidArgumentError);
    expect(() => productionReport([record], { ...period, groupBy: "none" })).toThrow(message);
  });

  it("rejects an invalid record even outside the window", () => {
    const bad: JobProductionRecord[] = [{ jobId: "a", status: "done", receivedAt: "2020-01-01T00:00:00Z" }];
    expect(() => productionReport(bad, { ...period, groupBy: "none" })).toThrow(InvalidArgumentError);
  });

  it("rejects a duplicate job id", () => {
    const duplicate: JobProductionRecord[] = [
      { jobId: "a", status: "received", receivedAt: "2026-03-01T01:00:00Z" },
      { jobId: "a", status: "received", receivedAt: "2026-03-01T02:00:00Z" },
    ];
    expect(() => productionReport(duplicate, { ...period, groupBy: "none" })).toThrow("duplicate job");
  });
});

describe("productionReportToCsv", () => {
  it("writes one row per group and a totals row, with empty turnaround when nothing completed", () => {
    const report = productionReport(records, { ...period, groupBy: "customer" });
    expect(productionReportToCsv(report)).toBe(
      [
        "group,jobs_received,jobs_completed,jobs_failed_or_cancelled,median_turnaround_ms,p90_turnaround_ms",
        "Acme,1,2,0,46800000,78480000",
        "Beta,3,1,0,14400000,14400000",
        "unassigned,1,0,1,,",
        "total,5,3,1,14400000,72000000",
        "",
      ].join("\r\n"),
    );
  });

  it("writes the header and a zero totals row for an empty report", () => {
    const report = productionReport([], { ...period, groupBy: "day" });
    expect(productionReportToCsv(report)).toBe(
      "group,jobs_received,jobs_completed,jobs_failed_or_cancelled,median_turnaround_ms,p90_turnaround_ms\r\ntotal,0,0,0,,\r\n",
    );
  });

  it("quotes per RFC 4180 and prefixes a single quote on labels that could start a formula", () => {
    const customers = ['Signs, "North" Ltd', "=SUM(A1:A2)", "@cmd", "-2"];
    const report = productionReport(
      customers.map(
        (customer, i): JobProductionRecord => ({ jobId: `j${i}`, status: "received", customer, receivedAt: "2026-03-01T01:00:00Z" }),
      ),
      { ...period, groupBy: "customer" },
    );
    const lines = productionReportToCsv(report).split("\r\n");
    expect(lines).toContain('"Signs, ""North"" Ltd",1,0,0,,');
    expect(lines).toContain("'=SUM(A1:A2),1,0,0,,");
    expect(lines).toContain("'@cmd,1,0,0,,");
    expect(lines).toContain("'-2,1,0,0,,");
    expect(lines.some((line) => /^[=+\-@]/.test(line))).toBe(false);
  });
});
