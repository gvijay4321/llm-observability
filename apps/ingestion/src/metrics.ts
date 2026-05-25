import type { MetricsSummary } from '@obs/shared';
import { getLogsSince } from './db/repository.js';

// Nearest-rank percentile over an already-sorted ascending array.
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank));
  return sortedAsc[idx]!;
}

const round = (n: number, dp = 2): number => Math.round(n * 10 ** dp) / 10 ** dp;

// In-process aggregation. Fine at demo scale; a real deployment would
// pre-aggregate or push to a timeseries DB.
export async function computeMetrics(windowMinutes: number): Promise<MetricsSummary> {
  const sinceMs = Date.now() - windowMinutes * 60_000;
  const rows = await getLogsSince(new Date(sinceMs).toISOString());

  const total = rows.length;
  const errors = rows.filter((r) => r.status === 'error').length;
  // Rows are ordered created_at ascending.
  const lastActivityAt = rows.length ? rows[rows.length - 1]!.created_at : null;

  const latencies = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
  const ttfts = rows
    .map((r) => r.ttft_ms)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);

  const avgLatency = latencies.length ? latencies.reduce((s, v) => s + v, 0) / latencies.length : 0;

  type Group = {
    provider: string;
    model: string;
    n: number;
    errs: number;
    lat: number;
    cost: number;
    lastOutput: string;
    lastAt: string | null;
  };
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const key = `${r.provider}:${r.model}`;
    const g =
      groups.get(key) ??
      { provider: r.provider, model: r.model, n: 0, errs: 0, lat: 0, cost: 0, lastOutput: '', lastAt: null };
    g.n += 1;
    g.lat += r.latency_ms;
    g.cost += r.estimated_cost_usd ?? 0;
    if (r.status === 'error') g.errs += 1;
    // Ascending-by-created_at means the last non-empty preview wins.
    if (r.output_preview) {
      g.lastOutput = r.output_preview;
      g.lastAt = r.created_at;
    }
    groups.set(key, g);
  }

  // ~30 buckets across the window.
  type Bucket = {
    requests: number;
    errors: number;
    lat: number;
    cost: number;
    latencies: number[];
    byProvider: Map<string, { requests: number; errors: number }>;
  };
  const bucketMin = Math.max(1, Math.ceil(windowMinutes / 30));
  const bucketMs = bucketMin * 60_000;
  const buckets = new Map<number, Bucket>();
  for (const r of rows) {
    const t = Date.parse(r.created_at);
    const bucket = Math.floor(t / bucketMs) * bucketMs;
    const b: Bucket =
      buckets.get(bucket) ??
      { requests: 0, errors: 0, lat: 0, cost: 0, latencies: [], byProvider: new Map() };
    b.requests += 1;
    b.lat += r.latency_ms;
    b.cost += r.estimated_cost_usd ?? 0;
    b.latencies.push(r.latency_ms);
    if (r.status === 'error') b.errors += 1;
    const bp = b.byProvider.get(r.provider) ?? { requests: 0, errors: 0 };
    bp.requests += 1;
    if (r.status === 'error') bp.errors += 1;
    b.byProvider.set(r.provider, bp);
    buckets.set(bucket, b);
  }

  return {
    windowMinutes,
    totalRequests: total,
    failedRequests: errors,
    lastActivityAt,
    errorRate: total ? round(errors / total, 4) : 0,
    throughputPerMin: round(total / windowMinutes, 2),
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      avg: round(avgLatency),
    },
    ttft: { p50: percentile(ttfts, 50), p95: percentile(ttfts, 95) },
    tokens: {
      prompt: sum(rows, (r) => r.prompt_tokens),
      completion: sum(rows, (r) => r.completion_tokens),
      total: sum(rows, (r) => r.total_tokens),
    },
    estimatedCostUsd: round(sum(rows, (r) => r.estimated_cost_usd), 6),
    byProvider: [...groups.values()]
      .map((g) => ({
        provider: g.provider,
        model: g.model,
        requests: g.n,
        errorRate: round(g.errs / g.n, 4),
        avgLatencyMs: round(g.lat / g.n),
        costUsd: round(g.cost, 6),
        lastOutput: g.lastOutput,
        lastAt: g.lastAt,
      }))
      .sort((a, b) => b.requests - a.requests),
    timeseries: [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ts, b]) => {
        const sortedLat = [...b.latencies].sort((a, c) => a - c);
        return {
          bucket: new Date(ts).toISOString(),
          requests: b.requests,
          errors: b.errors,
          avgLatencyMs: round(b.lat / b.requests),
          p50: percentile(sortedLat, 50),
          p95: percentile(sortedLat, 95),
          p99: percentile(sortedLat, 99),
          costUsd: round(b.cost, 6),
          byProvider: [...b.byProvider.entries()]
            .map(([provider, v]) => ({ provider, requests: v.requests, errors: v.errors }))
            .sort((a, c) => c.requests - a.requests),
        };
      }),
  };
}

function sum<T>(rows: T[], pick: (r: T) => number | null): number {
  return rows.reduce((s, r) => s + (pick(r) ?? 0), 0);
}
