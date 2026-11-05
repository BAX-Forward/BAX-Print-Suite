import { describe, expect, it } from "vitest";
import { parseTicketAccountingId, parseTicketEdits, ticketEdits, type JobTicket } from "../src/index.js";

const BASE: JobTicket = { intent: { quantity: 1 }, process: {} };

describe("ticket edits", () => {
  it("accepts a valid edit list and keeps its order", () => {
    const edits = [
      { kind: "rotate", degrees: 90 },
      { kind: "scale", percent: 50 },
      { kind: "addBleed", mm: 3, mode: "mirror" },
    ];
    const result = parseTicketEdits(edits);
    expect(result).toEqual({ ok: true, value: edits });
    if (!result.ok) return;
    const ticket: JobTicket = { ...BASE, edits: result.value ?? [] };
    expect(ticketEdits(ticket).map((e) => e.kind)).toEqual(["rotate", "scale", "addBleed"]);
  });

  it("rejects an invalid edit with an error on the edits field", () => {
    const result = parseTicketEdits([{ kind: "rotate", degrees: 45 }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.field).toBe("edits");
    expect(result.error.errors[0]).toMatch(/^edits\[0\]/);
  });

  it("rejects edits that are not a list", () => {
    const result = parseTicketEdits({ kind: "copies", count: 2 });
    expect(result.ok).toBe(false);
  });

  it("treats an absent edits field as no edits", () => {
    expect(parseTicketEdits(undefined)).toEqual({ ok: true, value: undefined });
    expect(ticketEdits(BASE)).toEqual([]);
  });

  it("round-trips edits through JSON, as a store does", () => {
    const ticket: JobTicket = { ...BASE, edits: [{ kind: "mirror", axis: "vertical" }, { kind: "copies", count: 4 }] };
    const restored = JSON.parse(JSON.stringify(ticket)) as JobTicket;
    expect(parseTicketEdits(restored.edits)).toEqual({ ok: true, value: ticket.edits });
  });
});

describe("ticket accounting ID", () => {
  it("accepts a valid accounting ID and trims it", () => {
    expect(parseTicketAccountingId("  CC-100/A  ")).toEqual({ ok: true, value: "CC-100/A" });
  });

  it("treats an absent accounting ID as no ID", () => {
    expect(parseTicketAccountingId(undefined)).toEqual({ ok: true, value: undefined });
  });

  it.each<[unknown, string]>([["", "empty"], ["a".repeat(65), "too long"], ["a;b", "bad character"], [7, "not a string"]])(
    "rejects %j (%s) with an error on the accountingId field",
    (input) => {
      const result = parseTicketAccountingId(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.field).toBe("accountingId");
      expect(result.error.errors).toHaveLength(1);
    },
  );

  it("round-trips an accounting ID through JSON, as a store does", () => {
    const ticket: JobTicket = { ...BASE, accountingId: "ACME" };
    const restored = JSON.parse(JSON.stringify(ticket)) as JobTicket;
    expect(parseTicketAccountingId(restored.accountingId)).toEqual({ ok: true, value: "ACME" });
  });
});
