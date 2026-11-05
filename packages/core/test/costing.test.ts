import { describe, expect, it } from "vitest";
import {
  costFromAccountingReport,
  estimateJobCost,
  InvalidArgumentError,
  validateCostTable,
  type CostTable,
  type DeviceAccountingReport,
} from "../src/index.js";

const table: CostTable = validateCostTable({
  currency: "EUR",
  media: [
    { name: "Gloss Film", pricePerSquareMetre: 10 },
    { name: "Unit Media", pricePerSquareMetre: 1 },
  ],
  ink: [
    { name: "Cyan", pricePerMillilitre: 0.12 },
    { name: "Black", pricePerMillilitre: 0.5 },
    { name: "Light A", pricePerMillilitre: 0.004 },
    { name: "Light B", pricePerMillilitre: 0.004 },
  ],
  other: [{ name: "Laminate", pricePerUnit: 2.5, unit: "sheet" }],
});

function report(quantities: DeviceAccountingReport["quantities"]): DeviceAccountingReport {
  return { jobId: "job-1", deviceId: "device-1", reportedAt: "2026-01-01T00:00:00Z", quantities };
}

describe("validateCostTable", () => {
  const valid = {
    currency: "EUR",
    media: [{ name: "M", pricePerSquareMetre: 1 }],
    ink: [{ name: "I", pricePerMillilitre: 1 }],
  };

  it("accepts a table without other items and returns a copy", () => {
    const result = validateCostTable(valid);
    expect(result).toEqual(valid);
    expect(result.media).not.toBe(valid.media);
    expect(result.other).toBeUndefined();
  });

  it.each([
    [null, "must be an object"],
    [[], "must be an object"],
    [{ ...valid, currency: "eur" }, "currency"],
    [{ ...valid, currency: "EURO" }, "currency"],
    [{ ...valid, currency: 978 }, "currency"],
    [{ ...valid, media: "M" }, "media must be an array"],
    [{ ...valid, ink: undefined }, "ink must be an array"],
    [{ ...valid, media: [{ name: "", pricePerSquareMetre: 1 }] }, "media[0].name"],
    [{ ...valid, media: [{ name: "M", pricePerSquareMetre: -1 }] }, "media[0].pricePerSquareMetre"],
    [{ ...valid, media: [{ name: "M", pricePerSquareMetre: Number.NaN }] }, "media[0].pricePerSquareMetre"],
    [{ ...valid, ink: [{ name: "I", pricePerMillilitre: Number.POSITIVE_INFINITY }] }, "ink[0].pricePerMillilitre"],
    [{ ...valid, ink: [{ name: "I", pricePerMillilitre: "1" }] }, "ink[0].pricePerMillilitre"],
    [{ ...valid, media: [{ name: "M", pricePerSquareMetre: 1 }, { name: "M", pricePerSquareMetre: 2 }] }, "duplicate media"],
    [{ ...valid, ink: [{ name: "I", pricePerMillilitre: 1 }, { name: "I", pricePerMillilitre: 1 }] }, "duplicate ink"],
    [{ ...valid, other: [{ name: "O", pricePerUnit: 1 }] }, "other[0].unit"],
    [{ ...valid, other: [{ name: "O", pricePerUnit: 1, unit: "u" }, { name: "O", pricePerUnit: 1, unit: "v" }] }, "duplicate other"],
    [{ ...valid, other: {} }, "other must be an array"],
  ])("rejects %j", (input, message) => {
    expect(() => validateCostTable(input)).toThrow(InvalidArgumentError);
    expect(() => validateCostTable(input)).toThrow(message);
  });
});

describe("estimateJobCost", () => {
  it("prices media by area and ink by millilitres per square metre", () => {
    const result = estimateJobCost(table, {
      mediaName: "Gloss Film",
      widthMm: 1000,
      lengthMm: 2000,
      copies: 1,
      inkMlPerSquareMetre: { Cyan: 5 },
    });
    expect(result.currency).toBe("EUR");
    expect(result.lines).toEqual([
      { kind: "media", name: "Gloss Film", quantity: 2, unit: "m2", cost: 2000 },
      { kind: "ink", name: "Cyan", quantity: 10, unit: "ml", cost: 120 },
    ]);
    expect(result.total).toBe(2120);
  });

  it("multiplies area by copies", () => {
    const result = estimateJobCost(table, {
      mediaName: "Gloss Film",
      widthMm: 500,
      lengthMm: 1000,
      copies: 3,
      inkMlPerSquareMetre: { Black: 4 },
    });
    expect(result.lines.map((line) => [line.quantity, line.cost])).toEqual([
      [1.5, 1500],
      [6, 300],
    ]);
    expect(result.total).toBe(1800);
  });

  it("rounds each line half-up to minor units", () => {
    const half = estimateJobCost(table, {
      mediaName: "Unit Media",
      widthMm: 500,
      lengthMm: 250,
      copies: 1,
      inkMlPerSquareMetre: {},
    });
    expect(half.lines[0]?.cost).toBe(13);
    expect(half.total).toBe(13);

    const binaryHalf = estimateJobCost(
      validateCostTable({ currency: "EUR", media: [{ name: "M", pricePerSquareMetre: 1.005 }], ink: [] }),
      { mediaName: "M", widthMm: 1000, lengthMm: 1000, copies: 1, inkMlPerSquareMetre: {} },
    );
    expect(binaryHalf.total).toBe(101);
  });

  it("sums rounded lines rather than rounding the sum", () => {
    const result = estimateJobCost(table, {
      mediaName: "Unit Media",
      widthMm: 1000,
      lengthMm: 1000,
      copies: 1,
      inkMlPerSquareMetre: { "Light A": 1, "Light B": 1 },
    });
    expect(result.lines.map((line) => line.cost)).toEqual([100, 0, 0]);
    expect(result.total).toBe(100);
  });

  it.each([
    [{ mediaName: "Missing" }, "no media price"],
    [{ inkMlPerSquareMetre: { Missing: 1 } }, "no ink price"],
    [{ inkMlPerSquareMetre: { Cyan: -1 } }, "inkMlPerSquareMetre"],
    [{ widthMm: 0 }, "widthMm"],
    [{ lengthMm: Number.NaN }, "lengthMm"],
    [{ copies: 0 }, "copies"],
    [{ copies: 1.5 }, "copies"],
  ])("rejects %j", (override, message) => {
    const input = { mediaName: "Gloss Film", widthMm: 100, lengthMm: 100, copies: 1, inkMlPerSquareMetre: {}, ...override };
    expect(() => estimateJobCost(table, input)).toThrow(InvalidArgumentError);
    expect(() => estimateJobCost(table, input)).toThrow(message);
  });
});

describe("costFromAccountingReport", () => {
  it("prices matching units and lists everything else as unpriced", () => {
    const result = costFromAccountingReport(
      table,
      report([
        { kind: "media", name: "Gloss Film", value: 1.25, unit: "m2" },
        { kind: "ink", name: "Cyan", value: 7.5, unit: "ml" },
        { kind: "other", name: "Laminate", value: 2, unit: "sheet" },
        { kind: "ink", name: "Cyan", value: 0.0075, unit: "l" },
        { kind: "ink", name: "Unknown Ink", value: 3, unit: "ml" },
        { kind: "media", name: "Gloss Film", value: 1250000, unit: "mm2" },
        { kind: "other", name: "Laminate", value: 1, unit: "m2" },
      ]),
    );
    expect(result.lines).toEqual([
      { kind: "media", name: "Gloss Film", quantity: 1.25, unit: "m2", cost: 1250 },
      { kind: "ink", name: "Cyan", quantity: 7.5, unit: "ml", cost: 90 },
      { kind: "other", name: "Laminate", quantity: 2, unit: "sheet", cost: 500 },
    ]);
    expect(result.total).toBe(1840);
    expect(result.currency).toBe("EUR");
    expect(result.unpriced).toEqual([
      { kind: "ink", name: "Cyan", value: 0.0075, unit: "l" },
      { kind: "ink", name: "Unknown Ink", value: 3, unit: "ml" },
      { kind: "media", name: "Gloss Film", value: 1250000, unit: "mm2" },
      { kind: "other", name: "Laminate", value: 1, unit: "m2" },
    ]);
  });

  it("rounds negative corrections half away from zero", () => {
    const result = costFromAccountingReport(table, report([{ kind: "media", name: "Unit Media", value: -0.125, unit: "m2" }]));
    expect(result.total).toBe(-13);
  });

  it("returns an empty result for an empty report", () => {
    const result = costFromAccountingReport(table, report([]));
    expect(result).toEqual({ lines: [], total: 0, currency: "EUR", unpriced: [] });
  });
});

describe("zero-cost table", () => {
  const free = validateCostTable({
    currency: "USD",
    media: [{ name: "M", pricePerSquareMetre: 0 }],
    ink: [{ name: "I", pricePerMillilitre: 0 }],
    other: [{ name: "O", pricePerUnit: 0, unit: "each" }],
  });

  it("estimates zero cost with full quantities", () => {
    const result = estimateJobCost(free, { mediaName: "M", widthMm: 1000, lengthMm: 1000, copies: 2, inkMlPerSquareMetre: { I: 3 } });
    expect(result.lines.map((line) => [line.quantity, line.cost])).toEqual([
      [2, 0],
      [6, 0],
    ]);
    expect(result.total).toBe(0);
    expect(result.currency).toBe("USD");
  });

  it("prices a report at zero", () => {
    const result = costFromAccountingReport(
      free,
      report([
        { kind: "ink", name: "I", value: 4, unit: "ml" },
        { kind: "other", name: "O", value: 1, unit: "each" },
      ]),
    );
    expect(result.total).toBe(0);
    expect(result.unpriced).toEqual([]);
  });
});
