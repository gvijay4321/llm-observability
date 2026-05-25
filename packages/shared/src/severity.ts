// Shared so the tile, dashboard, and per-provider table agree on amber/red.
// Gating on count + rate avoids 1/1 = 100% blips.

export type Severity = 'ok' | 'warn' | 'bad';

export interface SeverityThresholds {
  badMinFailures: number;
  badMinRate: number;
  warnMinFailures: number;
  warnMinRate: number;
}

export const DEFAULT_ERROR_THRESHOLDS: SeverityThresholds = {
  badMinFailures: 5,
  badMinRate: 0.2,
  warnMinFailures: 1,
  warnMinRate: 0.05,
};

export function errorSeverity(
  failed: number,
  total: number,
  t: SeverityThresholds = DEFAULT_ERROR_THRESHOLDS,
): Severity {
  if (total <= 0 || failed <= 0) return 'ok';
  const rate = failed / total;
  if (failed >= t.badMinFailures && rate >= t.badMinRate) return 'bad';
  if (failed >= t.warnMinFailures && rate >= t.warnMinRate) return 'warn';
  return 'ok';
}
