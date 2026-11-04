import { describe, expect, it } from "vitest";
import { parseTicketEdits, ticketEdits, type JobTicket } from "../src/index.js";

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
