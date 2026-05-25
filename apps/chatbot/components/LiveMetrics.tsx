'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip } from 'recharts';
import { errorSeverity, type MetricsSummary } from '@obs/shared';
import { METRIC_WINDOWS } from '@/lib/metric-windows';
import Link from 'next/link';
import { useSidebar } from './SidebarContext';
import { providerVisual } from './ProviderAvatar';
import { formatProvider } from '@/lib/providers-ui';

export interface ChartSpec {
  title: string;
  type: 'line' | 'bar' | 'area' | 'pie';
  series: 'requests' | 'errors' | 'latency' | 'providers';
}

export type MetricHighlight = 'requests' | 'errors' | 'latency' | 'tokens' | null;

const fmtNum = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const tooltipStyle = {
  background: '#1a1e28',
  border: '1px solid #262b38',
  borderRadius: 8,
  fontSize: 11,
};

function ProviderChip({ provider }: { provider: string }) {
  const v = providerVisual(provider);
  if (!v) {
    return (
      <span className="lm-prov-chip lm-prov-chip-fallback" aria-hidden>
        {provider.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <span className="lm-prov-chip" style={{ background: v.gradient }} aria-hidden>
      {v.icon}
    </span>
  );
}


export default function LiveMetrics({
  pingKey,
  highlight,
}: {
  pingKey: number;
  highlight: MetricHighlight;
}) {
  const sb = useSidebar();
  const windowMinutes = sb.metricsWindow;
  const setWindowMinutes = sb.setMetricsWindow;
  const collapsed = sb.metricsCollapsed;
  const setCollapsed = sb.setMetricsCollapsed;
  const [m, setM] = useState<MetricsSummary | null>(null);
  const [offline, setOffline] = useState(false);
  const [openProv, setOpenProv] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/metrics?windowMinutes=${windowMinutes}`);
      const data = (await res.json()) as { metrics?: MetricsSummary };
      if (data.metrics) {
        setM(data.metrics);
        setOffline(false);
      }
    } catch {
      setOffline(true);
    }
  }, [windowMinutes]);

  // Poll even when collapsed so the rail stats stay fresh and expanding is instant.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  // Read `load` via ref so a windowMinutes change doesn't re-fire this effect
  // (the polling effect above already fetched with the new window).
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    if (pingKey > 0) void loadRef.current();
  }, [pingKey]);

  if (collapsed) {
    return (
      <aside className="metrics collapsed" aria-label="Live metrics (collapsed)">
        <button
          type="button"
          className="lm-collapse-btn lm-rail"
          onClick={() => setCollapsed(false)}
          title="Expand live metrics"
          aria-label="Expand live metrics"
        >
          <span className="live-pulse" aria-hidden />
          <span className="lm-rail-label">LIVE METRICS</span>
          {m && <span className="lm-rail-stat">{m.totalRequests} req</span>}
          <span className="lm-rail-chevron" aria-hidden>‹</span>
        </button>
      </aside>
    );
  }

  const series = (m?.timeseries ?? []).map((p) => ({ i: p.bucket, requests: p.requests }));
  const errPct = m ? (m.errorRate * 100).toFixed(1) : '0.0';
  const errTone = m ? errorSeverity(m.failedRequests, m.totalRequests) : 'ok';
  // Carries the denominator so 100% of 3 reads differently from 100% of 300.
  const errSub =
    m && m.totalRequests > 0
      ? `${m.failedRequests} of ${m.totalRequests} failed`
      : `${m?.failedRequests ?? 0} failed`;
  const hl = (id: MetricHighlight) => `lm-tile${highlight === id ? ' hl' : ''}`;

  return (
    <aside className="metrics">
      <div className="metrics-head">
        <h2>Live Metrics</h2>
        <div className="metrics-head-right">
          <span className="live-tag">
            <span className="live-pulse" /> LIVE
          </span>
          <button
            type="button"
            className="lm-collapse-btn"
            onClick={() => setCollapsed(true)}
            title="Collapse live metrics"
            aria-label="Collapse live metrics"
          >
            ›
          </button>
        </div>
      </div>
      <div className="metrics-range">
        <select
          className="range-select"
          value={windowMinutes}
          onChange={(e) => setWindowMinutes(Number(e.target.value))}
          title="Window"
        >
          {METRIC_WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
      </div>

      {!m && <div className="lm-empty">{offline ? 'Ingestion service unreachable' : 'Loading metrics...'}</div>}

      {m && (
        <>
          <div className="lm-tiles">
            <div className={hl('requests')}>
              <div className="lm-label">Requests</div>
              <div className="lm-value">{m.totalRequests}</div>
              <div className="lm-sub">{m.throughputPerMin}/min</div>
            </div>
            <div className={hl('errors')}>
              <div className="lm-label">Error rate</div>
              <div className={`lm-value${errTone === 'ok' ? '' : ` ${errTone}`}`}>{errPct}%</div>
              <div className="lm-sub">{errSub}</div>
            </div>
            <div className={hl('latency')}>
              <div className="lm-label">Latency p95</div>
              <div className="lm-value">{m.latency.p95}</div>
              <div className="lm-sub">ms · p50 {m.latency.p50}</div>
            </div>
            <div className={hl('tokens')}>
              <div className="lm-label">Tokens</div>
              <div className="lm-value">{fmtNum(m.tokens.total)}</div>
              <div className="lm-sub">${m.estimatedCostUsd.toFixed(4)} est.</div>
            </div>
          </div>

          <div className="lm-card">
            <h3>Throughput · {(METRIC_WINDOWS.find((w) => w.value === windowMinutes)?.label ?? 'window').toLowerCase()}</h3>
            <div style={{ height: 96 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 4, right: 2, bottom: 0, left: 2 }}>
                  <defs>
                    <linearGradient id="lmFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6366f1" stopOpacity={0.55} />
                      <stop offset="100%" stopColor="#6366f1" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <Tooltip contentStyle={tooltipStyle} labelFormatter={() => ''} />
                  <Area
                    type="monotone"
                    dataKey="requests"
                    stroke="#818cf8"
                    strokeWidth={2}
                    fill="url(#lmFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="lm-card">
            <h3>By provider</h3>
            {m.byProvider.length === 0 && <div className="lm-sub">No traffic yet.</div>}
            {m.byProvider.slice(0, 4).map((p) => {
              const key = `${p.provider}:${p.model}`;
              const open = openProv === key;
              const hasAnswer = p.lastOutput.length > 0;
              return (
                <div className="lm-prov-block" key={key}>
                  <button
                    type="button"
                    className={`lm-prov lm-prov-toggle${open ? ' open' : ''}`}
                    onClick={() => setOpenProv(open ? null : key)}
                    disabled={!hasAnswer}
                    title={hasAnswer ? 'Show last answer' : 'No answer recorded yet'}
                  >
                    <div className="lm-prov-left">
                      <ProviderChip provider={p.provider} />
                      <div>
                        <div className="lm-prov-name">
                          <span className="lm-caret">{open ? '▾' : '▸'}</span> {formatProvider(p.provider)}
                        </div>
                        <div className="lm-prov-model">{p.model}</div>
                      </div>
                    </div>
                    <div className="lm-prov-stat">
                      {p.requests} req · {p.avgLatencyMs}ms
                    </div>
                  </button>
                  {open && hasAnswer && (
                    <div className="lm-prov-answer">
                      <div className="lm-prov-answer-meta">
                        Last answer{p.lastAt ? ` · ${fmtTime(p.lastAt)}` : ''}
                      </div>
                      <div className="lm-prov-answer-body">{p.lastOutput}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="lm-foot">
            <Link href="/dashboard" className="lm-foot-link">
              Open full dashboard <span aria-hidden>↗</span>
            </Link>
          </div>
        </>
      )}
    </aside>
  );
}
