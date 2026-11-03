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

export interface JobTicket {
  readonly intent: TicketIntent;
  /** Process parameters per stage (layout, render, cut, ...). */
  readonly process: Readonly<Record<string, unknown>>;
  /** Job editor edits (Spec 007), kept opaque here. */
  readonly edits?: readonly unknown[];
  /** Finishing mark specs (Spec 006), kept opaque here. */
  readonly marks?: readonly unknown[];
}
