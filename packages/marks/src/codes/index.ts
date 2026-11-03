/**
 * 2-D job codes (Spec 006 FR5). QR (ISO/IEC 18004, error correction M) via the
 * MIT-licensed `qrcode` package; Data Matrix ECC 200 via our own encoder.
 */
import QRCode from "qrcode";
import { MarkSpecError } from "../errors.js";
import type { CodeSpec } from "../schema.js";
import { encodeDataMatrix } from "./datamatrix.js";

export type Symbology = CodeSpec["symbology"];

export interface CodeMatrix {
  readonly symbology: Symbology;
  readonly payload: string;
  /** Modules per side, without the quiet zone. */
  readonly size: number;
  /** Row-major, row 0 at the top; true = dark. */
  readonly modules: boolean[][];
}

/** ISO/IEC 18004 requires 4; ISO/IEC 16022 requires 1, we default to 2. */
export const DEFAULT_QUIET_ZONE: Readonly<Record<Symbology, number>> = { qr: 4, datamatrix: 2 };

export interface PanelRef {
  readonly row: number;
  readonly col: number;
}

/** `bps:job/<jobId>[/panel/<r>-<c>]` or `<baseUrl>/jobs/<jobId>[?panel=<r>-<c>]`. */
export function codePayload(spec: Pick<CodeSpec, "payload" | "baseUrl">, jobId: string, panel?: PanelRef): string {
  const id = encodeURIComponent(jobId);
  const p = panel ? `${panel.row}-${panel.col}` : undefined;
  if (spec.payload === "url") {
    if (!spec.baseUrl) throw new MarkSpecError('code payload "url" requires baseUrl');
    return `${spec.baseUrl.replace(/\/+$/, "")}/jobs/${id}${p ? `?panel=${p}` : ""}`;
  }
  return `bps:job/${id}${p ? `/panel/${p}` : ""}`;
}

function encodeQr(payload: string): CodeMatrix {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const modules = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => Boolean(qr.modules.get(r, c))));
  return { symbology: "qr", payload, size: n, modules };
}

export function encodeCode(symbology: Symbology, payload: string): CodeMatrix {
  if (symbology === "qr") return encodeQr(payload);
  const dm = encodeDataMatrix(payload);
  return { symbology, payload, size: dm.size, modules: dm.modules };
}
