'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
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
import type { ChartSpec } from './LiveMetrics';
import { windowLabel } from '@/lib/metric-windows';
import { formatProvider, providerColor } from '@/lib/providers-ui';

interface Suggestion {
  text: string;
  blurb: string;
  chart: ChartSpec;
}

const SUGGESTIONS: Suggestion[] = [
  {
    text: 'What drives latency p95?',
    blurb: 'Tail of response times',
    chart: { title: 'Latency', type: 'area', series: 'latency' },
  },
  {
    text: 'How does throughput differ by provider?',
    blurb: 'Volume split by backend',
    chart: { title: 'Providers', type: 'bar', series: 'providers' },
  },
  {
    text: 'What causes error rate spikes?',
    blurb: 'Failures across the window',
    chart: { title: 'Errors', type: 'line', series: 'errors' },
  },
  {
    text: 'How is request volume trending?',
    blurb: 'Traffic shape across the window',
    chart: { title: 'Requests', type: 'bar', series: 'requests' },
  },
];

const PIE_COLORS = ['#818cf8', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#60a5fa'];

const TOOLTIP_CONTENT_STYLE = {
  background: '#1a1e28',
  border: '1px solid #262b38',
  borderRadius: 8,
  fontSize: 11,
  padding: '6px 8px',
};
const TOOLTIP_ITEM_STYLE = { color: '#e5e7eb', padding: 0 };
const TOOLTIP_LABEL_STYLE = { color: '#9ca3af', marginBottom: 2 };

const UNIT_BY_SERIES: Record<ChartSpec['series'], string> = {
  latency: 'ms',
  requests: 'req',
  errors: 'errors',
  providers: 'req',
};

const fmtBucketLabel = (raw: unknown): string => {
  if (typeof raw !== 'string') return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  // 7-day window buckets are daily or hourly; show date + short time.
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const fmtAxisDate = (raw: unknown): string => {
  if (typeof raw !== 'string') return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const fmtAxisNum = (n: number): string => {
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
};

const AXIS_TICK = { fill: '#8b91a4', fontSize: 10 };
const timeXAxisProps = {
  dataKey: 'label',
  height: 20,
  tickLine: false,
  axisLine: false,
  tickFormatter: fmtAxisDate,
  interval: 'preserveStartEnd' as const,
  minTickGap: 24,
  tick: AXIS_TICK,
  tickMargin: 4,
};
const yAxisProps = {
  width: 34,
  tickLine: false,
  axisLine: false,
  tickFormatter: fmtAxisNum,
  tick: AXIS_TICK,
  tickCount: 3,
};

interface Datum {
  label: string;
  value: number;
  id?: string;
}

function previewData(spec: ChartSpec, m: MetricsSummary): Datum[] {
  if (spec.series === 'providers') {
    // Same provider with different models gets duplicate bars otherwise.
    const sums = new Map<string, number>();
    for (const p of m.byProvider) {
      sums.set(p.provider, (sums.get(p.provider) ?? 0) + p.requests);
    }
    return [...sums.entries()]
      .map(([id, value]) => ({ id, label: formatProvider(id), value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 4);
  }
  const key = spec.series === 'latency' ? 'avgLatencyMs' : spec.series;
  return m.timeseries.map((t) => ({ label: t.bucket, value: t[key] }));
}

function MiniChart({ spec, data }: { spec: ChartSpec; data: Datum[] }) {
  const unit = UNIT_BY_SERIES[spec.series];
  const isTimeSeries = spec.series !== 'providers';
  const tooltipProps = {
    contentStyle: TOOLTIP_CONTENT_STYLE,
    itemStyle: TOOLTIP_ITEM_STYLE,
    labelStyle: TOOLTIP_LABEL_STYLE,
    cursor: { fill: 'rgba(129, 140, 248, 0.08)' },
    formatter: (v: number) => [`${v.toLocaleString()} ${unit}`, spec.title] as [string, string],
    labelFormatter: (raw: unknown) => (isTimeSeries ? fmtBucketLabel(raw) : String(raw ?? '')),
  };

  const chartMargin = { top: 6, right: 8, bottom: 0, left: 0 };

  if (spec.series === 'providers') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={chartMargin} barCategoryGap="30%">
          <YAxis {...yAxisProps} />
          <XAxis
            dataKey="label"
            height={20}
            tickLine={false}
            axisLine={false}
            interval={0}
            tick={AXIS_TICK}
            tickMargin={4}
          />
          <Tooltip {...tooltipProps} />
          <Bar dataKey="value" radius={[3, 3, 0, 0]} maxBarSize={22}>
            {data.map((d, i) => (
              <Cell key={d.id ?? d.label} fill={providerColor(d.id ?? '', i)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (spec.type === 'bar') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={chartMargin} barCategoryGap="30%">
          <defs>
            <linearGradient id={`sg-bar2-${spec.series}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.95} />
              <stop offset="100%" stopColor="#7c3aed" stopOpacity={0.45} />
            </linearGradient>
          </defs>
          <YAxis {...yAxisProps} />
          <XAxis {...timeXAxisProps} />
          <Tooltip {...tooltipProps} />
          <Bar dataKey="value" fill={`url(#sg-bar2-${spec.series})`} radius={[2, 2, 0, 0]} maxBarSize={14} />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (spec.type === 'pie') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip {...tooltipProps} />
          <Pie data={data} dataKey="value" nameKey="label" innerRadius="45%" outerRadius="85%"
            paddingAngle={2} stroke="none">
            {data.map((_, i) => (
              <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (spec.type === 'area') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={chartMargin}>
          <defs>
            <linearGradient id={`sg-area-${spec.series}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#818cf8" stopOpacity={0.55} />
              <stop offset="100%" stopColor="#818cf8" stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis {...yAxisProps} />
          <XAxis {...timeXAxisProps} />
          <Tooltip {...tooltipProps} />
          <Area type="monotone" dataKey="value" stroke="#818cf8" strokeWidth={1.8}
            fill={`url(#sg-area-${spec.series})`} />
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={chartMargin}>
        <YAxis {...yAxisProps} />
        <XAxis {...timeXAxisProps} />
        <Tooltip {...tooltipProps} />
        <Line type="monotone" dataKey="value" stroke="#f472b6" strokeWidth={1.8} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function SparkPlaceholder({ spec }: { spec: ChartSpec }) {
  const path =
    spec.type === 'bar' || spec.series === 'providers'
      ? 'M6 22V10 M14 22V6 M22 22V14 M30 22V8 M38 22V12'
      : spec.type === 'area'
        ? 'M2 20 L10 12 L18 16 L26 6 L34 10 L42 4 L42 22 L2 22 Z'
        : 'M2 18 L10 12 L18 15 L26 7 L34 11 L42 5';
  return (
    <svg viewBox="0 0 44 24" preserveAspectRatio="none" width="100%" height="100%" aria-hidden>
      <path
        d={path}
        fill={spec.type === 'area' ? 'rgba(129,140,248,0.18)' : 'none'}
        stroke={spec.series === 'errors' ? '#f472b6' : '#818cf8'}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Cards always preview the last 7 days so the mini charts have something
// to draw even when the sidebar window is "Last 15 min" on a quiet host.
const PREVIEW_WINDOW_MINUTES = 60 * 24 * 7;

function PromptIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4.5" width="18" height="15" rx="2.8" />
      <path d="M7.5 9.5 L11 12 L7.5 14.5" />
      <path d="M12.8 14.7 L16 14.7" />
    </svg>
  );
}

function PreviewSkeleton() {
  return (
    <div className="suggestion-card-skel" aria-label="Loading preview">
      <span className="suggestion-card-skel-bar" style={{ height: '40%' }} />
      <span className="suggestion-card-skel-bar" style={{ height: '70%' }} />
      <span className="suggestion-card-skel-bar" style={{ height: '55%' }} />
      <span className="suggestion-card-skel-bar" style={{ height: '85%' }} />
      <span className="suggestion-card-skel-bar" style={{ height: '50%' }} />
      <span className="suggestion-card-skel-bar" style={{ height: '65%' }} />
    </div>
  );
}

type LoadStatus = 'loading' | 'ready' | 'error';

export default function SuggestionCards({ onPick }: { onPick: (text: string) => void }) {
  const [m, setM] = useState<MetricsSummary | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/metrics?windowMinutes=${PREVIEW_WINDOW_MINUTES}`);
        const data = (await res.json()) as { metrics?: MetricsSummary };
        if (cancelled) return;
        if (data.metrics) {
          setM(data.metrics);
          setStatus('ready');
        } else {
          setStatus('error');
        }
      } catch {
        if (!cancelled) setStatus((s) => (s === 'ready' ? s : 'error'));
      }
    };
    void load();
    // Refresh while the empty state is on screen so the previews feel live.
    const timer = setInterval(() => void load(), 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const previews = useMemo(
    () => SUGGESTIONS.map((s) => ({ ...s, data: m ? previewData(s.chart, m) : [] })),
    [m],
  );

  return (
    <div className="suggestion-grid">
      {previews.map((s) => {
        const hasData = s.data.length > 0 && s.data.some((d) => d.value > 0);
        const showSkeleton = status === 'loading' && !m;
        return (
          <button
            key={s.text}
            type="button"
            className="suggestion-card"
            onClick={() => onPick(s.text)}
          >
            <div className="suggestion-card-head">
              <span className="suggestion-card-icon" aria-hidden>
                <PromptIcon />
              </span>
              <div className="suggestion-card-head-text">
                <div className="suggestion-card-text">{s.text}</div>
                <div className="suggestion-card-blurb">{s.blurb}</div>
              </div>
            </div>
            <div className="suggestion-card-preview">
              {showSkeleton ? (
                <PreviewSkeleton />
              ) : hasData ? (
                <MiniChart spec={s.chart} data={s.data} />
              ) : (
                <SparkPlaceholder spec={s.chart} />
              )}
            </div>
            <div className="suggestion-card-foot">
              <span
                className={`suggestion-card-dot${status === 'loading' ? ' is-loading' : status === 'error' ? ' is-error' : ''}`}
                aria-hidden
              />
              <span>
                {status === 'loading'
                  ? `loading · ${windowLabel(PREVIEW_WINDOW_MINUTES)}`
                  : status === 'error'
                    ? `offline · ${windowLabel(PREVIEW_WINDOW_MINUTES)}`
                    : `live · ${windowLabel(PREVIEW_WINDOW_MINUTES)}`}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
