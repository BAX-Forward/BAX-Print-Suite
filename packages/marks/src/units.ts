/** PDF points per millimetre (1 pt = 1/72 in, 1 in = 25.4 mm). */
export const PT_PER_MM = 72 / 25.4;
export const MM_PER_PT = 25.4 / 72;
export const MM_PER_IN = 25.4;

export const mmToPt = (mm: number): number => mm * PT_PER_MM;
export const ptToMm = (pt: number): number => pt * MM_PER_PT;
