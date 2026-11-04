import type { Static } from "@sinclair/typebox";
import { parseEdits, type JobEditListSchema } from "./edits.js";

export interface FinishedSize {
  readonly widthMm: number;
  readonly heightMm: number;
}

/** Product intent, shaped after XJDF intent concepts in our own names. */
export interface TicketIntent {
  readonly quantity: number;
  readonly finishedSize?: FinishedSize;
  readonly mediaIntent?: string;
  readonly colorIntent?: string;
}

/** Job editor edits (Spec 007 FR4), applied in order at layout time. */
export type TicketEdits = Static<typeof JobEditListSchema>;

export interface JobTicket {
  readonly intent: TicketIntent;
  /** Process parameters per stage (layout, render, cut, ...). */
  readonly process: Readonly<Record<string, unknown>>;
  /** Job editor edits (Spec 007). Absent means no edits. */
  readonly edits?: TicketEdits;
  /** Finishing mark specs (Spec 006), kept opaque here. */
  readonly marks?: readonly unknown[];
}

/** A validation error tied to one ticket field, e.g. `edits`. */
export interface TicketFieldError {
  readonly field: string;
  readonly errors: readonly string[];
}

export type TicketEditsResult = { ok: true; value: TicketEdits | undefined } | { ok: false; error: TicketFieldError };

/** Validates the `edits` field of an incoming ticket. An absent field is valid (no edits). */
export function parseTicketEdits(input: unknown): TicketEditsResult {
  if (input === undefined) return { ok: true, value: undefined };
  const parsed = parseEdits(input);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: { field: "edits", errors: parsed.errors } };
}

/** The ticket's edit stack; an empty list when the ticket has none. */
export function ticketEdits(ticket: Pick<JobTicket, "edits">): TicketEdits {
  return ticket.edits ?? [];
}
