'use client';

import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { errorSeverity, type MetricsSummary, type Severity } from '@obs/shared';
import { DEFAULT_WINDOW, METRIC_WINDOWS } from '@/lib/metric-windows';
import { providerVisual } from './ProviderAvatar';
import { formatModelTag, formatProvider, providerColor } from '@/lib/providers-ui';

type IconName =
  | 'requests'
  | 'failed'
  | 'errorRate'
  | 'latency'
  | 'ttft'
  | 'tokens'
  | 'cost'
  | 'throughput'
  | 'errors'
  | 'percentiles'
  | 'costPanel'
  | 'table';

const ICONS: Record<IconName, ReactElement> = {
  requests: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 11l3-4 3 2 5-6" />
      <path d="M11 3h3v3" />
    </svg>
  ),
  failed: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 2l6.2 11H1.8z" />
      <path d="M8 7v3" />
      <circle cx="8" cy="11.6" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  errorRate: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="5" cy="5" r="1.7" />
      <circle cx="11" cy="11" r="1.7" />
      <path d="M13 3L3 13" />
    </svg>
  ),
  latency: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="8.5" r="5.5" />
      <path d="M8 5.5V9l2 1.5" />
    </svg>
  ),
  ttft: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="9" r="5" />
      <path d="M8 4V2M6.5 2h3" />
      <path d="M8 6.5v2.5L10 10" />
    </svg>
  ),
  tokens: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 5.5l5-2.5 5 2.5L8 8z" />
      <path d="M3 8l5 2.5L13 8" />
      <path d="M3 10.5L8 13l5-2.5" />
    </svg>
  ),
  cost: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.5 4.5C10 3.6 9 3 8 3c-1.7 0-3 1-3 2.3 0 3 6 1.7 6 4.7 0 1.3-1.3 2.3-3 2.3-1 0-2-.6-2.5-1.5" />
      <path d="M8 2v1.2M8 12.3V13.5" />
    </svg>
  ),
  throughput: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12l3.5-5 3 2.5L13 4" />
      <path d="M2 13.5h12" />
    </svg>
  ),
  errors: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 13V8M7 13V5M11 13V9" />
      <path d="M2 13.5h12" />
    </svg>
  ),
  percentiles: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 11l3-2 3 1 3-3 3 1.5" />
      <circle cx="5" cy="9" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="11" cy="7" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  ),
  costPanel: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.2" y="3.5" width="11.6" height="9" rx="1.6" />
      <path d="M5 7.5h2.5M5 10h4.5" />
      <path d="M11 7h1.5" />
    </svg>
  ),
  table: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.2" y="3" width="11.6" height="10" rx="1.4" />
      <path d="M2.2 6.5h11.6M6 6.5V13" />
    </svg>
  ),
};

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never';

const fmtRelative = (iso: string | null): string => {
  if (!iso) return 'no activity';
  const diffSec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 45) return 'just now';
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86_400)}d ago`;
};

const axis = {
  stroke: '#5c6173',
  fontSize: 10.5,
  tickLine: false,
  axisLine: false,
  tickMargin: 8,
};

type ChartId = 'throughput' | 'errors' | 'latency' | 'cost';
type ViewMode = 'chart' | 'table';
type LatencySeries = 'p50' | 'p95' | 'p99';

const LATENCY_SERIES: Array<{ key: LatencySeries; color: string }> = [
  { key: 'p50', color: '#a78bfa' },
  { key: 'p95', color: '#fbbf24' },
  { key: 'p99', color: '#f87171' },
];

export default function Dashboard() {
  const [windowMinutes, setWindowMinutes] = useState(DEFAULT_WINDOW);
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refetching, setRefetching] = useState(false);
  const [hiddenThroughput, setHiddenThroughput] = useState<Set<string>>(new Set());
  const [hiddenErrors, setHiddenErrors] = useState<Set<string>>(new Set());
  const [hiddenLatency, setHiddenLatency] = useState<Set<LatencySeries>>(new Set());
  const [chartView, setChartView] = useState<Record<ChartId, ViewMode>>({
    throughput: 'chart',
    errors: 'chart',
    latency: 'chart',
    cost: 'chart',
  });
  const setView = useCallback((id: ChartId, v: ViewMode) => {
    setChartView((prev) => ({ ...prev, [id]: v }));
  }, []);

  const toggleThroughput = useCallback((name: string) => {
    setHiddenThroughput((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);
  const toggleErrors = useCallback((name: string) => {
    setHiddenErrors((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);
  const toggleLatency = useCallback((key: LatencySeries) => {
    setHiddenLatency((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setRefetching(true);
      try {
        const res = await fetch(`/api/metrics?windowMinutes=${windowMinutes}`);
        const data = (await res.json()) as { metrics?: MetricsSummary; error?: string };
        if (data.metrics) {
          setMetrics(data.metrics);
          setError(null);
        } else {
          setError(data.error ?? 'No metrics available');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!silent) setRefetching(false);
      }
    },
    [windowMinutes],
  );

  useEffect(() => {
    void load(false);
    const timer = setInterval(() => void load(true), 4000);
    return () => clearInterval(timer);
  }, [load]);

  const series = useMemo(
    () => (metrics?.timeseries ?? []).map((p) => ({ ...p, t: fmtTime(p.bucket) })),
    [metrics],
  );
  const errorPct = metrics ? (metrics.errorRate * 100).toFixed(1) : '0.0';

  const sparkRequests = useMemo(() => series.map((p) => ({ v: p.requests })), [series]);
  const sparkErrors = useMemo(() => series.map((p) => ({ v: p.errors })), [series]);
  const sparkErrorRate = useMemo(
    () => series.map((p) => ({ v: p.requests ? (p.errors / p.requests) * 100 : 0 })),
    [series],
  );
  const sparkLatency = useMemo(() => series.map((p) => ({ v: p.p50 })), [series]);
  const sparkCost = useMemo(() => series.map((p) => ({ v: p.costUsd })), [series]);

  // Flatten each bucket's byProvider list into per-provider fields so recharts
  // can stack them. Requests and errors share the same per-provider buckets.
  const stackedSeries = useMemo(() => {
    if (!metrics) {
      return {
        providers: [] as string[],
        requestsData: [] as Array<Record<string, number | string>>,
        errorsData: [] as Array<Record<string, number | string>>,
        totalErrors: 0,
      };
    }
    const providers = Array.from(
      new Set(metrics.timeseries.flatMap((b) => b.byProvider.map((p) => p.provider))),
    );
    const requestsData = metrics.timeseries.map((b) => {
      const row: Record<string, number | string> = { t: fmtTime(b.bucket) };
      for (const p of providers) {
        row[p] = b.byProvider.find((x) => x.provider === p)?.requests ?? 0;
      }
      return row;
    });
    const errorsData = metrics.timeseries.map((b) => {
      const row: Record<string, number | string> = { t: fmtTime(b.bucket) };
      for (const p of providers) {
        row[p] = b.byProvider.find((x) => x.provider === p)?.errors ?? 0;
      }
      return row;
    });
    return { providers, requestsData, errorsData, totalErrors: metrics.failedRequests };
  }, [metrics]);

  // Keep zero-cost rows in so free providers stay visible next to paid ones.
  const costRows = useMemo(() => {
    if (!metrics) return [];
    return metrics.byProvider
      .map((p) => {
        const shortModel = p.model.split('/').pop() ?? p.model;
        return {
          label: `${formatProvider(p.provider)} · ${formatModelTag(p.provider, shortModel)}`,
          provider: p.provider,
          cost: p.costUsd,
        };
      })
      .sort((a, b) => b.cost - a.cost);
  }, [metrics]);

  // Per-column maxes for the inline bars in the table; scaled to visible rows.
  const tableMax = useMemo(() => {
    const rows = metrics?.byProvider ?? [];
    return {
      requests: Math.max(1, ...rows.map((p) => p.requests)),
      latency: Math.max(1, ...rows.map((p) => p.avgLatencyMs)),
    };
  }, [metrics]);

  return (
    <div className={`dash${refetching ? ' is-refetching' : ''}`}>
      <div className="dash-head">
        <div className="dash-head-left">
          <div>
            <div className="dash-eyebrow">Observability</div>
            <h1>Inference Dashboard</h1>
          </div>
        </div>
        <div className="dash-head-right">
          {refetching && (
            <span className="dash-loading" role="status" aria-live="polite">
              <span className="dash-loading-spinner" aria-hidden />
              Updating…
            </span>
          )}
          <select
            className={`dash-select${refetching ? ' is-loading' : ''}`}
            value={windowMinutes}
            onChange={(e) => setWindowMinutes(Number(e.target.value))}
            disabled={refetching}
          >
            {METRIC_WINDOWS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="note">Ingestion unreachable: {error}</div>}
      {!metrics && !error && <div className="spinner">Loading metrics...</div>}

      {metrics && (
        <>
          <div className="cards">
            <Card
              icon="requests"
              iconTint="#818cf8"
              label="Requests"
              value={String(metrics.totalRequests)}
              subStat={{ label: 'rate', value: `${metrics.throughputPerMin}/min` }}
              spark={{ data: sparkRequests, color: '#818cf8' }}
            />
            <Card
              icon="failed"
              iconTint="#f59e0b"
              label="Failed requests"
              value={String(metrics.failedRequests)}
              tone={errorSeverity(metrics.failedRequests, metrics.totalRequests)}
              subStat={
                metrics.lastActivityAt
                  ? { label: 'last', value: fmtRelative(metrics.lastActivityAt) }
                  : { label: 'last', value: 'no activity' }
              }
              subTitle={metrics.lastActivityAt ? fmtDateTime(metrics.lastActivityAt) : undefined}
              spark={{ data: sparkErrors, color: '#f59e0b' }}
            />
            <Card
              icon="errorRate"
              iconTint="#f59e0b"
              label="Error rate"
              value={`${errorPct}%`}
              tone={errorSeverity(metrics.failedRequests, metrics.totalRequests)}
              sub={
                metrics.totalRequests > 0
                  ? `${metrics.failedRequests} of ${metrics.totalRequests} failed`
                  : undefined
              }
              spark={{ data: sparkErrorRate, color: '#f59e0b' }}
            />
            <Card
              icon="latency"
              iconTint="#a78bfa"
              label="Latency p50"
              value={`${metrics.latency.p50} ms`}
              subStat={{ label: 'avg', value: `${metrics.latency.avg} ms` }}
              spark={{ data: sparkLatency, color: '#a78bfa' }}
            />
            <Card
              icon="latency"
              iconTint="#a78bfa"
              label="Latency p95"
              value={`${metrics.latency.p95} ms`}
              subStat={{ label: 'p99', value: `${metrics.latency.p99} ms` }}
            />
            <Card
              icon="ttft"
              iconTint="#fbbf24"
              label="TTFT p50"
              value={`${metrics.ttft.p50} ms`}
              subStat={{ label: 'p95', value: `${metrics.ttft.p95} ms` }}
            />
            <Card
              icon="tokens"
              iconTint="#60a5fa"
              label="Tokens"
              value={fmtNum(metrics.tokens.total)}
              subStat={[
                { label: 'in', value: fmtNum(metrics.tokens.prompt) },
                { label: 'out', value: fmtNum(metrics.tokens.completion) },
              ]}
              subTitle={`${metrics.tokens.prompt.toLocaleString()} prompt + ${metrics.tokens.completion.toLocaleString()} completion`}
            />
            <Card
              icon="cost"
              iconTint="#34d399"
              label="Est. cost"
              value={`$${metrics.estimatedCostUsd.toFixed(4)}`}
              spark={{ data: sparkCost, color: '#34d399' }}
            />
          </div>

          <div className="panel-box">
            <div className="panel-head">
              <PanelTitle icon="throughput" tint="#818cf8">Throughput by Provider</PanelTitle>
              <div className="panel-head-right">
                <ProviderLegend
                  providers={stackedSeries.providers}
                  hidden={hiddenThroughput}
                  onToggle={toggleThroughput}
                />
                <ViewToggle value={chartView.throughput} onChange={(v) => setView('throughput', v)} />
              </div>
            </div>
            {chartView.throughput === 'chart' ? (
              <div style={{ height: 260 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={stackedSeries.requestsData}
                    margin={{ top: 10, right: 12, bottom: 0, left: -8 }}
                    barCategoryGap="22%"
                    barGap={3}
                  >
                    <CartesianGrid stroke="#1f2330" strokeDasharray="2 6" vertical={false} />
                    <XAxis dataKey="t" {...axis} />
                    <YAxis {...axis} allowDecimals={false} width={32} />
                    <Tooltip content={<ProviderTooltip />} cursor={{ fill: '#ffffff08' }} />
                    {stackedSeries.providers.map((p, i) => (
                      <Bar
                        key={p}
                        dataKey={p}
                        fill={providerColor(p, i)}
                        name={p}
                        maxBarSize={18}
                        radius={[3, 3, 0, 0]}
                        hide={hiddenThroughput.has(p)}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <BucketProviderTable
                rows={stackedSeries.requestsData}
                providers={stackedSeries.providers}
                hidden={hiddenThroughput}
              />
            )}
          </div>

          {stackedSeries.totalErrors > 0 && (
            <div className="panel-box">
              <div className="panel-head">
                <PanelTitle icon="errors" tint="#f59e0b">Errors by Provider</PanelTitle>
                <div className="panel-head-right">
                  <ProviderLegend
                    providers={stackedSeries.providers}
                    hidden={hiddenErrors}
                    onToggle={toggleErrors}
                    meta={`total ${stackedSeries.totalErrors} in window`}
                  />
                  <ViewToggle value={chartView.errors} onChange={(v) => setView('errors', v)} />
                </div>
              </div>
              {chartView.errors === 'chart' ? (
                <div style={{ height: 220 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={stackedSeries.errorsData}
                      margin={{ top: 10, right: 12, bottom: 0, left: -8 }}
                      barCategoryGap="22%"
                      barGap={3}
                    >
                      <CartesianGrid stroke="#1f2330" strokeDasharray="2 6" vertical={false} />
                      <XAxis dataKey="t" {...axis} />
                      <YAxis {...axis} allowDecimals={false} width={32} />
                      <Tooltip
                        content={<ProviderTooltip />}
                        cursor={{ fill: '#ffffff08' }}
                      />
                      {stackedSeries.providers.map((p, i) => (
                        <Bar
                          key={p}
                          dataKey={p}
                          fill={providerColor(p, i)}
                          name={p}
                          maxBarSize={18}
                          radius={[3, 3, 0, 0]}
                          hide={hiddenErrors.has(p)}
                        />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <BucketProviderTable
                  rows={stackedSeries.errorsData}
                  providers={stackedSeries.providers}
                  hidden={hiddenErrors}
                />
              )}
            </div>
          )}

          <div className="panel-box">
            <div className="panel-head">
              <PanelTitle icon="percentiles" tint="#a78bfa">Latency Percentiles (ms)</PanelTitle>
              <div className="panel-head-right">
                <LatencyLegend hidden={hiddenLatency} onToggle={toggleLatency} />
                <ViewToggle value={chartView.latency} onChange={(v) => setView('latency', v)} />
              </div>
            </div>
            {chartView.latency === 'chart' ? (
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series} margin={{ top: 10, right: 12, bottom: 0, left: -4 }}>
                    <CartesianGrid stroke="#1f2330" strokeDasharray="2 6" vertical={false} />
                    <XAxis dataKey="t" {...axis} />
                    <YAxis
                      {...axis}
                      width={56}
                      tickFormatter={(v: number) => `${v} ms`}
                    />
                    <Tooltip content={<LatencyTooltip />} cursor={{ stroke: '#3a3f4f', strokeWidth: 1 }} />
                    {LATENCY_SERIES.map(({ key, color }) => (
                      <Line
                        key={key}
                        type="monotone"
                        dataKey={key}
                        stroke={color}
                        strokeWidth={1.7}
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0 }}
                        name={key}
                        hide={hiddenLatency.has(key)}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <LatencyTable rows={series} />
            )}
          </div>

          {costRows.length > 0 && (
            <div className="panel-box">
              <div className="panel-head">
                <PanelTitle icon="costPanel" tint="#34d399">Cost by Model</PanelTitle>
                <div className="panel-head-right">
                  <div className="panel-legend">
                    <span>
                      total ${metrics.estimatedCostUsd.toFixed(4)}
                      {costRows.some((r) => r.cost === 0) && ' · free tiers shown empty'}
                    </span>
                  </div>
                  <ViewToggle value={chartView.cost} onChange={(v) => setView('cost', v)} />
                </div>
              </div>
              {chartView.cost === 'chart' ? (
                <div style={{ height: Math.max(80, costRows.length * 38 + 20) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={costRows}
                      layout="vertical"
                      margin={{ top: 4, right: 24, bottom: 4, left: 0 }}
                      barCategoryGap="35%"
                    >
                      <CartesianGrid stroke="#1f2330" strokeDasharray="2 6" horizontal={false} />
                      <XAxis
                        type="number"
                        {...axis}
                        tickFormatter={(v: number) => `$${v.toFixed(4)}`}
                      />
                      <YAxis
                        type="category"
                        dataKey="label"
                        {...axis}
                        width={210}
                        tick={{ fill: '#c0c5d4', fontSize: 12 }}
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        cursor={{ fill: '#ffffff08' }}
                        formatter={(v: number) => [`$${v.toFixed(6)}`, 'Cost']}
                      />
                      <Bar dataKey="cost" radius={[0, 4, 4, 0]} maxBarSize={22}>
                        {costRows.map((row, i) => (
                          <Cell key={row.label} fill={providerColor(row.provider, i)} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <CostTable rows={costRows} />
              )}
            </div>
          )}

          <div className="panel-box">
            <div className="panel-head">
              <PanelTitle icon="table" tint="#8b91a4">By Provider / Model</PanelTitle>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Requests</th>
                  <th>Error rate</th>
                  <th>Avg latency</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {metrics.byProvider.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ color: '#8b90a0' }}>
                      No data in this window yet - send a few chat messages.
                    </td>
                  </tr>
                )}
                {metrics.byProvider.map((p) => {
                  const key = `${p.provider}:${p.model}`;
                  const reqPct = (p.requests / tableMax.requests) * 100;
                  const latPct = (p.avgLatencyMs / tableMax.latency) * 100;
                  return (
                    <tr key={key} className="dash-row">
                      <td>
                        <span className="dash-prov-cell">
                          <ProviderTile provider={p.provider} />
                          {formatProvider(p.provider)}
                        </span>
                      </td>
                      <td>{p.model}</td>
                      <td>
                        <span className="dash-bar-val">{p.requests}</span>
                        <span
                          className="dash-bar-fill dash-bar-fill--requests"
                          style={{ width: `${reqPct}%` }}
                          aria-hidden
                        />
                      </td>
                      <td className={errCellClass(Math.round(p.requests * p.errorRate), p.requests)}>
                        {(p.errorRate * 100).toFixed(1)}%
                      </td>
                      <td>
                        <span className="dash-bar-val">{p.avgLatencyMs} ms</span>
                        <span
                          className="dash-bar-fill dash-bar-fill--latency"
                          style={{ width: `${latPct}%` }}
                          aria-hidden
                        />
                      </td>
                      <td>
                        {p.costUsd > 0 ? (
                          `$${p.costUsd.toFixed(6)}`
                        ) : (
                          <span className="dash-free-tag">Free</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function PanelTitle({
  icon,
  tint,
  children,
}: {
  icon: IconName;
  tint: string;
  children: ReactNode;
}) {
  return (
    <h3 className="panel-title">
      <span className="panel-title-icon" style={{ color: tint }} aria-hidden>
        {ICONS[icon]}
      </span>
      {children}
    </h3>
  );
}

interface TooltipPayloadItem {
  dataKey?: string | number;
  name?: string;
  value?: number;
  color?: string;
}

function ProviderTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="dash-tip">
      <div className="dash-tip-head">{label}</div>
      <div className="dash-tip-rows">
        {payload.map((p) => {
          const name = String(p.name ?? p.dataKey ?? '');
          return (
            <div key={name} className="dash-tip-row">
              <ProviderTile provider={name} />
              <span className="dash-tip-name">{formatProvider(name)}</span>
              <span className="dash-tip-val" style={{ color: p.color }}>{p.value ?? 0}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProviderLegend({
  providers,
  hidden,
  onToggle,
  meta,
}: {
  providers: string[];
  hidden: Set<string>;
  onToggle: (name: string) => void;
  meta?: string;
}) {
  return (
    <div className="panel-legend panel-legend--providers">
      {providers.map((p) => {
        const off = hidden.has(p);
        return (
          <button
            key={p}
            type="button"
            className={`panel-legend-item${off ? ' is-off' : ''}`}
            onClick={() => onToggle(p)}
            aria-pressed={!off}
            title={off ? `Show ${formatProvider(p)}` : `Hide ${formatProvider(p)}`}
          >
            <ProviderTile provider={p} />
            {formatProvider(p)}
          </button>
        );
      })}
      {meta && <span className="panel-legend-meta">{meta}</span>}
    </div>
  );
}

function LatencyLegend({
  hidden,
  onToggle,
}: {
  hidden: Set<LatencySeries>;
  onToggle: (key: LatencySeries) => void;
}) {
  return (
    <div className="panel-legend panel-legend--latency">
      {LATENCY_SERIES.map(({ key, color }) => {
        const off = hidden.has(key);
        return (
          <button
            key={key}
            type="button"
            className={`panel-legend-item${off ? ' is-off' : ''}`}
            onClick={() => onToggle(key)}
            aria-pressed={!off}
            title={off ? `Show ${key}` : `Hide ${key}`}
          >
            <i style={{ background: color }} />
            {key}
          </button>
        );
      })}
    </div>
  );
}

function LatencyTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="dash-tip">
      <div className="dash-tip-head">{label}</div>
      <div className="dash-tip-rows">
        {payload.map((p) => {
          const name = String(p.name ?? p.dataKey ?? '');
          return (
            <div key={name} className="dash-tip-row dash-tip-row--latency">
              <i className="dash-tip-dot" style={{ background: p.color }} />
              <span className="dash-tip-name">{name}</span>
              <span className="dash-tip-val" style={{ color: p.color }}>{p.value ?? 0} ms</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProviderTile({ provider }: { provider: string }) {
  const v = providerVisual(provider);
  if (!v) {
    return (
      <span className="dash-prov-tile dash-prov-tile--fallback" aria-hidden>
        {provider.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return (
    <span className="dash-prov-tile" style={{ background: v.gradient }} aria-hidden>
      {v.icon}
    </span>
  );
}

interface SparkProps {
  data: Array<{ v: number }>;
  color: string;
}

function Card({
  icon,
  iconTint,
  label,
  value,
  sub,
  subStat,
  subTitle,
  tone,
  spark,
}: {
  icon?: IconName;
  iconTint?: string;
  label: string;
  value: string;
  sub?: string;
  subStat?: { label: string; value: string } | Array<{ label: string; value: string }>;
  subTitle?: string;
  tone?: Severity;
  spark?: SparkProps;
}) {
  const hasSpark = spark && spark.data.length > 1 && spark.data.some((d) => d.v > 0);
  const chips = subStat ? (Array.isArray(subStat) ? subStat : [subStat]) : null;
  return (
    <div className={`card${hasSpark ? ' card--spark' : ''}`}>
      {icon && (
        <span className="card-icon" style={{ color: iconTint ?? 'var(--muted)' }} aria-hidden>
          {ICONS[icon]}
        </span>
      )}
      <div className="label">{label}</div>
      <div className={`value${tone && tone !== 'ok' ? ` ${tone}` : ''}`}>{value}</div>
      {chips && (
        <div className="card-stats" title={subTitle}>
          {chips.map((s) => (
            <div key={s.label} className="card-stat">
              <span className="card-stat-label">{s.label}</span>
              <span className="card-stat-value">{s.value}</span>
            </div>
          ))}
        </div>
      )}
      {sub && !chips && (
        <div className="sub" title={subTitle}>
          {sub}
        </div>
      )}
      {hasSpark && (
        <div className="card-spark" aria-hidden>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={spark!.data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`spark-${label.replace(/\s+/g, '')}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={spark!.color} stopOpacity={0.45} />
                  <stop offset="100%" stopColor={spark!.color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke={spark!.color}
                strokeWidth={1.4}
                fill={`url(#spark-${label.replace(/\s+/g, '')})`}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

const tooltipStyle = {
  background: '#1d212c',
  border: '1px solid #2a2f3c',
  borderRadius: 8,
  fontSize: 12,
};

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function errCellClass(failed: number, total: number): string {
  const sev = errorSeverity(failed, total);
  if (sev === 'bad') return 'dash-err-cell dash-err-cell--bad';
  if (sev === 'warn') return 'dash-err-cell dash-err-cell--warn';
  return 'dash-err-cell dash-err-cell--ok';
}

function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="view-toggle" role="group" aria-label="View as chart or table">
      <button
        type="button"
        className={`view-toggle-btn${value === 'chart' ? ' is-active' : ''}`}
        onClick={() => onChange('chart')}
        aria-pressed={value === 'chart'}
        title="Chart view"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 13V8M7 13V5M11 13V9" />
          <path d="M2 13.5h12" />
        </svg>
      </button>
      <button
        type="button"
        className={`view-toggle-btn${value === 'table' ? ' is-active' : ''}`}
        onClick={() => onChange('table')}
        aria-pressed={value === 'table'}
        title="Table view"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="2.2" y="3" width="11.6" height="10" rx="1.4" />
          <path d="M2.2 6.5h11.6M6 6.5V13" />
        </svg>
      </button>
    </div>
  );
}

function BucketProviderTable({
  rows,
  providers,
  hidden,
}: {
  rows: Array<Record<string, number | string>>;
  providers: string[];
  hidden: Set<string>;
}) {
  const visible = providers.filter((p) => !hidden.has(p));
  if (rows.length === 0) {
    return <div className="panel-empty">No data in this window.</div>;
  }
  return (
    <div className="panel-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            {visible.map((p) => (
              <th key={p}>{formatProvider(p)}</th>
            ))}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const total = visible.reduce((sum, p) => sum + (Number(row[p]) || 0), 0);
            return (
              <tr key={`${row.t}-${i}`}>
                <td>{row.t}</td>
                {visible.map((p) => (
                  <td key={p}>{Number(row[p]) || 0}</td>
                ))}
                <td>{total}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LatencyTable({
  rows,
}: {
  rows: Array<{ t: string; p50: number; p95: number; p99: number; avgLatencyMs: number }>;
}) {
  if (rows.length === 0) return <div className="panel-empty">No latency data in this window.</div>;
  return (
    <div className="panel-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>p50</th>
            <th>p95</th>
            <th>p99</th>
            <th>Avg</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.t}-${i}`}>
              <td>{r.t}</td>
              <td>{r.p50} ms</td>
              <td>{r.p95} ms</td>
              <td>{r.p99} ms</td>
              <td>{r.avgLatencyMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CostTable({
  rows,
}: {
  rows: Array<{ label: string; provider: string; cost: number }>;
}) {
  return (
    <div className="panel-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Provider · Model</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>
                <span className="dash-prov-cell">
                  <ProviderTile provider={r.provider} />
                  {r.label}
                </span>
              </td>
              <td>
                {r.cost > 0 ? `$${r.cost.toFixed(6)}` : <span className="dash-free-tag">Free</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
