import { describe, expect, it } from "vitest";
import {
  buildCostReport,
  costFromAccountingReport,
  costReportToCsv,
  csvSafeText,
  InvalidArgumentError,
  validateCostTable,
  type AccountingCost,
  type AccountingQuantity,
  type CostEstimate,
  type CostReportOptions,
  type JobCostRecord,
} from "../src/index.js";

function estimate(total: number, currency = "EUR"): CostEstimate {
  return { lines: [], total, currency };
}

function actual(total: number, unpriced: readonly AccountingQuantity[] = [], currency = "EUR"): AccountingCost {
  return { lines: [], total, currency, unpriced };
}

const period: Omit<CostReportOptions, "groupBy"> = { from: "2026-03-01T00:00:00Z", to: "2026-03-03T00:00:00Z" };

const records: readonly JobCostRecord[] = [
  {
    jobId: "job-1",
    completedAt: "2026-03-01T00:00:00Z",
    customer: "Acme",
    deviceId: "dev-a",
    estimate: estimate(1000),
    actual: actual(1200),
  },
  { jobId: "job-2", completedAt: "2026-03-01T23:59:59.999Z", customer: "Acme", deviceId: "dev-b", estimate: estimate(500) },
  {
    jobId: "job-3",
    completedAt: "2026-03-02T10:00:00Z",
    deviceId: "dev-a",
    actual: actual(300, [{ kind: "ink", name: "Cyan", value: 2, unit: "l" }]),
  },
  { jobId: "job-4", completedAt: "2026-03-02T12:00:00Z", customer: "Beta" },
  // On the exclusive end of the period; its other currency must not raise a mixed-currency error.
  { jobId: "job-5", completedAt: "2026-03-03T00:00:00Z", customer: "Acme", estimate: estimate(9999, "USD") },
  { jobId: "job-6", completedAt: "2026-02-28T23:59:59Z", customer: "Acme", estimate: estimate(7777) },
];

const expectedTotals = { jobs: 4, estimatedMinor: 1500, actualMinor: 1500, varianceMinor: 200, unpricedJobs: 2 };

describe("buildCostReport period", () => {
  it("includes from and excludes to and anything earlier", () => {
    const report = buildCostReport(records, { ...period, groupBy: "none" });
    expect(report.currency).toBe("EUR");
    expect(report.from).toBe(period.from);
    expect(report.to).toBe(period.to);
    expect(report.totals).toEqual(expectedTotals);
  });

  it("returns no groups, zero totals and no currency for an empty period", () => {
    const report = buildCostReport(records, { from: "2027-01-01T00:00:00Z", to: "2027-02-01T00:00:00Z", groupBy: "customer" });
    expect(report.currency).toBeNull();
    expect(report.groups).toEqual([]);
    expect(report.totals).toEqual({ jobs: 0, estimatedMinor: 0, actualMinor: 0, varianceMinor: 0, unpricedJobs: 0 });
  });
});

describe("buildCostReport groupBy", () => {
  it("groups by customer with missing customers as unassigned", () => {
    const report = buildCostReport(records, { ...period, groupBy: "customer" });
    expect(report.groups).toEqual([
      { key: "Acme", jobs: 2, estimatedMinor: 1500, actualMinor: 1200, varianceMinor: 200, unpricedJobs: 0 },
      { key: "Beta", jobs: 1, estimatedMinor: 0, actualMinor: 0, varianceMinor: 0, unpricedJobs: 1 },
      { key: "unassigned", jobs: 1, estimatedMinor: 0, actualMinor: 300, varianceMinor: 0, unpricedJobs: 1 },
    ]);
    expect(report.totals).toEqual(expectedTotals);
  });

  it("groups by device with missing devices as unassigned", () => {
    const report = buildCostReport(records, { ...period, groupBy: "device" });
    expect(report.groups).toEqual([
      { key: "dev-a", jobs: 2, estimatedMinor: 1000, actualMinor: 1500, varianceMinor: 200, unpricedJobs: 1 },
      { key: "dev-b", jobs: 1, estimatedMinor: 500, actualMinor: 0, varianceMinor: 0, unpricedJobs: 0 },
      { key: "unassigned", jobs: 1, estimatedMinor: 0, actualMinor: 0, varianceMinor: 0, unpricedJobs: 1 },
    ]);
  });

  it("groups by UTC day in date order", () => {
    const report = buildCostReport(records, { ...period, groupBy: "day" });
    expect(report.groups).toEqual([
      { key: "2026-03-01", jobs: 2, estimatedMinor: 1500, actualMinor: 1200, varianceMinor: 200, unpricedJobs: 0 },
      { key: "2026-03-02", jobs: 2, estimatedMinor: 0, actualMinor: 300, varianceMinor: 0, unpricedJobs: 2 },
    ]);
  });

  it("puts every job in one group when not grouped", () => {
    const report = buildCostReport(records, { ...period, groupBy: "none" });
    expect(report.groups).toEqual([{ key: "all", ...expectedTotals }]);
  });

  it("treats a blank customer as unassigned", () => {
    const report = buildCostReport([{ jobId: "j", completedAt: "2026-03-01T08:00:00Z", customer: "  ", estimate: estimate(1) }], {
      ...period,
      groupBy: "customer",
    });
    expect(report.groups.map((group) => group.key)).toEqual(["unassigned"]);
  });

  it("counts a job with both estimate and actual once", () => {
    const report = buildCostReport(records.slice(0, 1), { ...period, groupBy: "customer" });
    expect(report.totals.jobs).toBe(1);
    expect(report.groups).toHaveLength(1);
  });
});

describe("buildCostReport variance and unpriced", () => {
  it("computes variance only over jobs with both estimate and actual", () => {
    const report = buildCostReport(
      [
        { jobId: "both-over", completedAt: "2026-03-01T01:00:00Z", estimate: estimate(1000), actual: actual(1100) },
        { jobId: "both-under", completedAt: "2026-03-01T02:00:00Z", estimate: estimate(400), actual: actual(350) },
        { jobId: "estimate-only", completedAt: "2026-03-01T03:00:00Z", estimate: estimate(5000) },
        { jobId: "actual-only", completedAt: "2026-03-01T04:00:00Z", actual: actual(800) },
      ],
      { ...period, groupBy: "none" },
    );
    expect(report.totals).toEqual({ jobs: 4, estimatedMinor: 6400, actualMinor: 2250, varianceMinor: 50, unpricedJobs: 0 });
  });

  it("counts jobs with no cost or with unpriced reported quantities", () => {
    const table = validateCostTable({ currency: "EUR", media: [{ name: "Film", pricePerSquareMetre: 10 }], ink: [] });
    const priced = costFromAccountingReport(table, {
      jobId: "priced",
      deviceId: "dev-a",
      reportedAt: "2026-03-01T05:00:00Z",
      quantities: [{ kind: "media", name: "Film", value: 1, unit: "m2" }],
    });
    const partial = costFromAccountingReport(table, {
      jobId: "partial",
      deviceId: "dev-a",
      reportedAt: "2026-03-01T06:00:00Z",
      quantities: [
        { kind: "media", name: "Film", value: 1, unit: "m2" },
        { kind: "other", name: "Laminate", value: 1, unit: "sheet" },
      ],
    });
    const report = buildCostReport(
      [
        { jobId: "priced", completedAt: "2026-03-01T05:00:00Z", actual: priced },
        { jobId: "partial", completedAt: "2026-03-01T06:00:00Z", actual: partial },
        { jobId: "estimated", completedAt: "2026-03-01T07:00:00Z", estimate: estimate(10) },
        { jobId: "nothing", completedAt: "2026-03-01T08:00:00Z" },
      ],
      { ...period, groupBy: "none" },
    );
    expect(report.totals.unpricedJobs).toBe(2);
    expect(report.totals.actualMinor).toBe(2000);
  });
});

describe("buildCostReport validation", () => {
  it("rejects mixed currencies across jobs", () => {
    const mixed: JobCostRecord[] = [
      { jobId: "a", completedAt: "2026-03-01T01:00:00Z", estimate: estimate(100, "EUR") },
      { jobId: "b", completedAt: "2026-03-01T02:00:00Z", actual: actual(100, [], "USD") },
    ];
    expect(() => buildCostReport(mixed, { ...period, groupBy: "none" })).toThrow(InvalidArgumentError);
    expect(() => buildCostReport(mixed, { ...period, groupBy: "none" })).toThrow("mixed currencies");
  });

  it("rejects mixed currencies within one job", () => {
    const mixed: JobCostRecord[] = [
      { jobId: "a", completedAt: "2026-03-01T01:00:00Z", estimate: estimate(100, "EUR"), actual: actual(100, [], "GBP") },
    ];
    expect(() => buildCostReport(mixed, { ...period, groupBy: "none" })).toThrow("mixed currencies");
  });

  it.each([
    [{ from: "2026-03-01", to: period.to }, "from"],
    [{ from: period.from, to: "2026-03-03T00:00:00+01:00" }, "to"],
    [{ from: "2026-02-30T00:00:00Z", to: period.to }, "from"],
    [{ from: "not a date", to: period.to }, "from"],
    [{ from: period.to, to: period.from }, "earlier than"],
    [{ from: period.from, to: period.from }, "earlier than"],
  ])("rejects period %j", (bounds, message) => {
    expect(() => buildCostReport([], { ...bounds, groupBy: "none" })).toThrow(InvalidArgumentError);
    expect(() => buildCostReport([], { ...bounds, groupBy: "none" })).toThrow(message);
  });

  it("rejects an invalid completedAt even outside the period", () => {
    const bad: JobCostRecord[] = [{ jobId: "a", completedAt: "yesterday" }];
    expect(() => buildCostReport(bad, { ...period, groupBy: "none" })).toThrow(InvalidArgumentError);
    expect(() => buildCostReport(bad, { ...period, groupBy: "none" })).toThrow("records[0].completedAt");
  });

  it("rejects a duplicate job id", () => {
    const duplicate: JobCostRecord[] = [
      { jobId: "a", completedAt: "2026-03-01T01:00:00Z" },
      { jobId: "a", completedAt: "2026-03-01T02:00:00Z" },
    ];
    expect(() => buildCostReport(duplicate, { ...period, groupBy: "none" })).toThrow("duplicate job");
  });

  it("rejects a non-integer amount", () => {
    const fractional: JobCostRecord[] = [{ jobId: "a", completedAt: "2026-03-01T01:00:00Z", estimate: estimate(1.5) }];
    expect(() => buildCostReport(fractional, { ...period, groupBy: "none" })).toThrow(InvalidArgumentError);
  });
});

describe("costReportToCsv", () => {
  it("quotes per RFC 4180 and ends with a totals row", () => {
    const report = buildCostReport(
      [
        {
          jobId: "a",
          completedAt: "2026-03-01T01:00:00Z",
          customer: 'Signs, "North" Ltd',
          estimate: estimate(1005),
          actual: actual(1000),
        },
        { jobId: "b", completedAt: "2026-03-01T02:00:00Z", customer: "Plain", actual: actual(12345) },
      ],
      { ...period, groupBy: "customer" },
    );
    expect(costReportToCsv(report)).toBe(
      [
        "group,jobs,currency,estimated,actual,variance,unpriced_jobs",
        "Plain,1,EUR,0.00,123.45,0.00,0",
        '"Signs, ""North"" Ltd",1,EUR,10.05,10.00,-0.05,0',
        "total,2,EUR,10.05,133.45,-0.05,0",
        "",
      ].join("\r\n"),
    );
  });

  it("writes the header and a zero totals row for an empty report", () => {
    const report = buildCostReport([], { ...period, groupBy: "day" });
    expect(costReportToCsv(report)).toBe(
      "group,jobs,currency,estimated,actual,variance,unpriced_jobs\r\ntotal,0,,0.00,0.00,0.00,0\r\n",
    );
  });

  it("prefixes a single quote on group labels that could start a formula", () => {
    const names = ["=SUM(A1:A2)", "+1", "-2", "@cmd", "\tTab", "\rCR"];
    const report = buildCostReport(
      names.map((customer, i) => ({
        jobId: `j${i}`,
        completedAt: "2026-03-01T01:00:00Z",
        customer,
        actual: actual(100),
      })),
      { ...period, groupBy: "customer" },
    );
    const lines = costReportToCsv(report).split("\r\n");
    for (const name of names) {
      expect(lines.some((line) => line.startsWith(`'${name}`) || line.startsWith(`"'${name}`))).toBe(true);
    }
    expect(lines.some((line) => /^[=+\-@]/.test(line))).toBe(false);
  });

  it("keeps negative amounts numeric and leaves safe text untouched", () => {
    expect(csvSafeText("Plain")).toBe("Plain");
    expect(csvSafeText("a=b")).toBe("a=b");
    expect(csvSafeText("")).toBe("");
    expect(csvSafeText("=1+1")).toBe("'=1+1");
    const report = buildCostReport(
      [{ jobId: "a", completedAt: "2026-03-01T01:00:00Z", customer: "Shop", estimate: estimate(1005), actual: actual(1000) }],
      { ...period, groupBy: "customer" },
    );
    expect(costReportToCsv(report)).toContain("Shop,1,EUR,10.05,10.00,-0.05,0");
  });
});
