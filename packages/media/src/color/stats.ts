export interface DeltaSummary {
  count: number;
  mean: number;
  p95: number;
  max: number;
}

/** Nearest-rank percentile (p in 0..100). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new RangeError('percentile: no values');
  const sorted = [...values].sort((x, y) => x - y);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export function summarize(values: readonly number[]): DeltaSummary {
  if (values.length === 0) throw new RangeError('summarize: no values');
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return { count: values.length, mean, p95: percentile(values, 95), max: Math.max(...values) };
}
