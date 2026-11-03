import type { RectMm } from "./types.js";

export const PT_PER_MM = 72 / 25.4;

/** Tolerance for comparing lengths in mm (floating-point noise from seam arithmetic). */
export const EPS_MM = 1e-9;

export function mmToPt(mm: number): number {
  return mm * PT_PER_MM;
}

export function ptToMm(pt: number): number {
  return pt / PT_PER_MM;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function rect(x: number, y: number, width: number, height: number): RectMm {
  return { x, y, width, height };
}
