'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MetricsSummary } from '@obs/shared';
import { METRIC_WINDOWS } from '@/lib/metric-windows';
import type { ChartSpec } from './LiveMetrics';
import { useSidebar } from './SidebarContext';
import { formatProvider } from '@/lib/providers-ui';

type ChartType = ChartSpec['type'];

const tooltipStyle = {
  background: '#1a1e28',
  border: '1px solid #262b38',
  borderRadius: 8,
  fontSize: 11,
};
const axis = {
  stroke: '#5c6173',
  fontSize: 10.5,
  tickLine: false,
  axisLine: false,
  tickMargin: 6,
};

const PIE_COLORS = ['#818cf8', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#60a5fa'];

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

interface Datum {
  label: string;
  value: number;
}

function chartData(spec: ChartSpec, m: MetricsSummary): Datum[] {
  if (spec.series === 'providers') {
    // byProvider is keyed by provider+model; collapse to one slice per provider.
    const totals = new Map<string, number>();
    for (const p of m.byProvider) {
      totals.set(p.provider, (totals.get(p.provider) ?? 0) + p.requests);
    }
    return [...totals.entries()]
      .map(([provider, value]) => ({ label: formatProvider(provider), value }))
      .sort((a, b) => b.value - a.value);
  }
  const key = spec.series === 'latency' ? 'avgLatencyMs' : spec.series;
  return m.timeseries.map((t) => ({ label: fmtTime(t.bucket), value: t[key] }));
}

function validTypesFor(series: ChartSpec['series']): ChartType[] {
  if (series === 'providers') return ['bar', 'pie'];
  return ['line', 'area', 'bar'];
}

const TYPE_LABEL: Record<ChartType, string> = {
  line: 'Line',
  area: 'Area',
  bar: 'Bar',
  pie: 'Pie',
};

const TypeIcon = ({ type }: { type: ChartType }) => {
  switch (type) {
    case 'bar':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M6 20V10M12 20V4M18 20v-7" />
        </svg>
      );
    case 'pie':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 2a10 10 0 1 0 10 10H12V2z" />
          <path d="M12 2a10 10 0 0 1 10 10" />
        </svg>
      );
    case 'area':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 17l5-6 4 3 5-7 4 5v5H3z" fill="currentColor" fillOpacity="0.18" />
          <path d="M3 17l5-6 4 3 5-7 4 5" />
        </svg>
      );
    case 'line':
    default:
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 17l5-6 4 3 5-7 4 5" />
        </svg>
      );
  }
};

export default function InlineChart({ spec }: { spec: ChartSpec }) {
  const sb = useSidebar();
  const windowMinutes = sb.metricsWindow;
  const [m, setM] = useState<MetricsSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const available = useMemo(() => validTypesFor(spec.series), [spec.series]);
  const initialType: ChartType = available.includes(spec.type) ? spec.type : available[0]!;
  const [type, setType] = useState<ChartType>(initialType);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/metrics?windowMinutes=${windowMinutes}`);
        const data = (await res.json()) as { metrics?: MetricsSummary };
        if (!cancelled) {
          if (data.metrics) setM(data.metrics);
          else setErr('No metrics available');
        }
      } catch {
        if (!cancelled) setErr('Ingestion unreachable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [windowMinutes]);

  const windowLabel =
    METRIC_WINDOWS.find((w) => w.value === windowMinutes)?.label.toLowerCase() ?? 'window';

  const data = useMemo(() => (m ? chartData(spec, m) : []), [m, spec]);
  const hasData = data.length > 0 && data.some((d) => d.value > 0);

  return (
    <div className="inline-chart">
      <div className="inline-chart-head">
        <div>
          <div className="inline-chart-title">{spec.title}</div>
          <div className="inline-chart-meta">{spec.series} · {windowLabel}</div>
        </div>
        <div className="inline-chart-types" role="tablist" aria-label="Chart type">
          {available.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={type === t}
              className={`inline-chart-type${type === t ? ' active' : ''}`}
              onClick={() => setType(t)}
              title={TYPE_LABEL[t]}
            >
              <TypeIcon type={t} />
            </button>
          ))}
        </div>
      </div>
      <div className="inline-chart-body">
        {err && <div className="inline-chart-empty">{err}</div>}
        {!err && !m && <div className="inline-chart-empty">Loading data…</div>}
        {!err && m && !hasData && (
          <div className="inline-chart-empty">No data in the {windowLabel} for this series.</div>
        )}
        {!err && m && hasData && (
          <ResponsiveContainer width="100%" height="100%">
            {type === 'pie' ? (
              <PieChart>
                <Tooltip contentStyle={tooltipStyle} />
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="label"
                  innerRadius="45%"
                  outerRadius="80%"
                  paddingAngle={2}
                  stroke="none"
                  label={({ label, value }) => `${label}: ${value}`}
                  labelLine={false}
                >
                  {data.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
              </PieChart>
            ) : type === 'bar' ? (
              <BarChart
                data={data}
                margin={{ top: 8, right: 8, bottom: 0, left: -12 }}
                barCategoryGap="35%"
              >
                <defs>
                  <linearGradient id={`ic-bar-${spec.series}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.95} />
                    <stop offset="100%" stopColor="#7c3aed" stopOpacity={0.55} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#1f2330" strokeDasharray="2 6" vertical={false} />
                <XAxis dataKey="label" {...axis} />
                <YAxis {...axis} width={32} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: '#ffffff08' }} />
                <Bar
                  dataKey="value"
                  fill={`url(#ic-bar-${spec.series})`}
                  radius={[3, 3, 0, 0]}
                  maxBarSize={32}
                />
              </BarChart>
            ) : type === 'area' ? (
              <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                <defs>
                  <linearGradient id={`ic-area-${spec.series}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#818cf8" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#818cf8" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#1f2330" strokeDasharray="2 6" vertical={false} />
                <XAxis dataKey="label" {...axis} />
                <YAxis {...axis} width={32} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="#818cf8"
                  strokeWidth={1.5}
                  fill={`url(#ic-area-${spec.series})`}
                />
              </AreaChart>
            ) : (
              <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="#1f2330" strokeDasharray="2 6" vertical={false} />
                <XAxis dataKey="label" {...axis} />
                <YAxis {...axis} width={32} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#818cf8"
                  strokeWidth={1.5}
                  dot={false}
                />
              </LineChart>
            )}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
