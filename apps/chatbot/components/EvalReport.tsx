'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatModelTag, formatProvider } from '@/lib/providers-ui';
import { ProviderLabel } from './ProviderLabel';

type Category = 'factual' | 'adversarial' | 'bias';

interface EvalResult {
  promptId: string;
  category: Category;
  provider: string;
  model: string;
  blockedByGuardrails: boolean;
  response: string;
  latencyMs: number;
  errored: boolean;
  heuristic: { score: number; refused: boolean; leaked: boolean };
  judge?: { score: number };
}

interface EvalRun {
  generatedAt: string;
  judge: { provider: string; model: string } | null;
  results: EvalResult[];
}

interface ProviderRoll {
  provider: string;
  model: string;
  byCategory: Record<Category, { n: number; heur: number; judge: number | null }>;
  totalLatencyMs: number;
  totalCalls: number;
}

const CAT_ORDER: Category[] = ['factual', 'adversarial', 'bias'];
const CAT_COLOR: Record<Category, string> = {
  factual: '#2ba884',
  adversarial: '#4a8bb8',
  bias: '#8470c8',
};
const CAT_LABEL: Record<Category, string> = {
  factual: 'Hallucination',
  adversarial: 'Content Safety',
  bias: 'Bias & Harmful',
};
const CAT_LABEL_SHORT: Record<Category, string> = {
  factual: 'hallucination',
  adversarial: 'content safety',
  bias: 'bias & harmful',
};

function roll(results: EvalResult[]): ProviderRoll[] {
  const out = new Map<string, ProviderRoll>();
  for (const r of results) {
    let row = out.get(r.provider);
    if (!row) {
      row = {
        provider: r.provider,
        model: r.model,
        byCategory: {
          factual: { n: 0, heur: 0, judge: null },
          adversarial: { n: 0, heur: 0, judge: null },
          bias: { n: 0, heur: 0, judge: null },
        },
        totalLatencyMs: 0,
        totalCalls: 0,
      };
      out.set(r.provider, row);
    }
    const cat = row.byCategory[r.category];
    cat.n += 1;
    cat.heur += r.heuristic.score;
    if (r.judge) cat.judge = (cat.judge ?? 0) + r.judge.score;
    row.totalCalls += 1;
    row.totalLatencyMs += r.latencyMs;
  }
  return Array.from(out.values()).sort((a, b) => avgScore(b) - avgScore(a));
}

function avgScore(row: ProviderRoll): number {
  const scores = CAT_ORDER.map((c) => row.byCategory[c])
    .filter((c) => c.n > 0)
    .map((c) => c.heur / c.n);
  if (scores.length === 0) return 0;
  return scores.reduce((s, v) => s + v, 0) / scores.length;
}

function pct(x: number): number {
  return Math.round(x * 100);
}

function shorten(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export default function EvalReport() {
  const [run, setRun] = useState<EvalRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/eval-latest.json')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} — has the eval ever been run?`);
        return r.json() as Promise<EvalRun>;
      })
      .then(setRun)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const rolled = useMemo(() => (run ? roll(run.results) : []), [run]);

  const safetyByProvider = useMemo(() => {
    if (!run) return [] as { provider: string; blocks: number; refusals: number; leaks: number; n: number }[];
    const map = new Map<string, { provider: string; blocks: number; refusals: number; leaks: number; n: number }>();
    for (const r of run.results) {
      let row = map.get(r.provider);
      if (!row) {
        row = { provider: r.provider, blocks: 0, refusals: 0, leaks: 0, n: 0 };
        map.set(r.provider, row);
      }
      row.n += 1;
      if (r.blockedByGuardrails) row.blocks += 1;
      if (r.heuristic.refused) row.refusals += 1;
      if (r.heuristic.leaked) row.leaks += 1;
    }
    return Array.from(map.values()).sort((a, b) => b.leaks - a.leaks || a.provider.localeCompare(b.provider));
  }, [run]);

  if (error) {
    return (
      <div className="eval">
        <div className="eval-head">
          <div>
            <div className="dash-eyebrow">Evaluation</div>
            <h1>Cross-provider evaluation</h1>
          </div>
        </div>
        <div className="note">
          Could not load eval data: {error}. Run <code>npm run eval</code> to generate it.
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="eval">
        <div className="eval-head">
          <div>
            <div className="dash-eyebrow">Evaluation</div>
            <h1>Cross-provider evaluation</h1>
          </div>
        </div>
        <div className="spinner">Loading eval results…</div>
      </div>
    );
  }

  const generated = new Date(run.generatedAt).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="eval">
      <div className="eval-head">
        <div>
          <div className="dash-eyebrow">Evaluation</div>
          <h1>Cross-provider evaluation</h1>
        </div>
        <div className="eval-meta">
          <div className="eval-meta-cell">
            <svg
              className="eval-meta-cell-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="5" width="18" height="16" rx="2" />
              <line x1="3" y1="10" x2="21" y2="10" />
              <line x1="8" y1="3" x2="8" y2="7" />
              <line x1="16" y1="3" x2="16" y2="7" />
            </svg>
            <span className="eval-meta-cell-label">Generated</span>
            <span className="eval-meta-cell-value">{generated}</span>
          </div>
          <div className="eval-meta-cell eval-meta-cell-accent">
            <svg
              className="eval-meta-cell-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3v18" />
              <path d="M9 21h6" />
              <path d="M4 7h16" />
              <path d="M6 7 L2 13 A4 4 0 0 0 10 13 Z" />
              <path d="M18 7 L14 13 A4 4 0 0 0 22 13 Z" />
            </svg>
            <span className="eval-meta-cell-label">Judge</span>
            <span className="eval-meta-cell-value">
              {run.judge
                ? `${formatProvider(run.judge.provider)} · ${formatModelTag(run.judge.provider, run.judge.model)}`
                : 'Heuristics only'}
            </span>
          </div>
        </div>
      </div>

      <div className="eval-panel">
        <h2>Overall heuristic score</h2>
        <div className="eval-tiles">
          {rolled.map((r) => {
            const overall = avgScore(r);
            const latency = r.totalCalls ? Math.round(r.totalLatencyMs / r.totalCalls) : 0;
            const scoreTier = overall >= 0.7 ? 'good' : overall >= 0.4 ? 'mid' : 'bad';
            const latencyTier = latency < 500 ? 'good' : latency <= 2000 ? 'mid' : 'bad';
            return (
              <div key={r.provider} className="eval-tile">
                <div className="eval-tile-name"><ProviderLabel provider={r.provider} /></div>
                <div className={`eval-tile-score eval-tile-score-${scoreTier}`}>
                  {pct(overall)}
                  <span>%</span>
                </div>
                <div className={`eval-tile-sub eval-tile-sub-${latencyTier}`}>
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <polyline points="12 7 12 12 15 14" />
                  </svg>
                  {latency} ms avg
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="eval-panel">
        <h2>Safety signals</h2>
        <table className="eval-safety-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th title="Prompts blocked by the pattern guardrail layer before reaching the model">Ingress&nbsp;blocks</th>
              <th title="Model refused to comply (safe deflection)">Model&nbsp;refusals</th>
              <th title="Response contained a known jailbreak / leak marker — lower is better">Leak&nbsp;markers</th>
              <th>Prompts</th>
            </tr>
          </thead>
          <tbody>
            {safetyByProvider.map((row) => (
              <tr key={row.provider}>
                <td><ProviderLabel provider={row.provider} /></td>
                <td className="eval-safety-num">{row.blocks}</td>
                <td className="eval-safety-num">{row.refusals}</td>
                <td
                  className={`eval-safety-num ${row.leaks > 0 ? 'eval-safety-num-bad' : 'eval-safety-num-ok'}`}
                >
                  {row.leaks}
                </td>
                <td className="eval-safety-num eval-safety-num-muted">{row.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="eval-panel">
        <h2>Per-category breakdown</h2>
        <div className="eval-chart">
          {rolled.map((row) => (
            <div key={row.provider} className="eval-row">
              <div className="eval-row-label">
                <div className="eval-row-name"><ProviderLabel provider={row.provider} /></div>
                <div className="eval-row-model">{shorten(row.model, 26)}</div>
              </div>
              <div className="eval-row-bars">
                {CAT_ORDER.map((cat) => {
                  const stat = row.byCategory[cat];
                  const value = stat.n ? stat.heur / stat.n : 0;
                  return (
                    <div key={cat} className="eval-bar-row">
                      <div className="eval-bar-cat">{CAT_LABEL_SHORT[cat]}</div>
                      <div className="eval-bar-track">
                        <div
                          className="eval-bar-fill"
                          style={{
                            width: `${Math.max(1, value * 100)}%`,
                            backgroundColor: CAT_COLOR[cat],
                          }}
                        />
                      </div>
                      <div className="eval-bar-val">{pct(value)}%</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="eval-legend">
          {CAT_ORDER.map((cat) => (
            <span key={cat}>
              <i style={{ background: CAT_COLOR[cat] }} />
              {CAT_LABEL[cat]}
            </span>
          ))}
        </div>
      </div>

    </div>
  );
}
