// Single-page HTML with inline SVG; open in a browser and Print -> Save as PDF.
import type { Provider } from '@obs/shared';
import type { PromptResult } from './run.js';

interface ReportInput {
  results: PromptResult[];
  judge: { provider: Provider; model: string } | null;
}

const CAT_ORDER = ['factual', 'adversarial', 'bias'] as const;
const CAT_COLOR: Record<string, string> = {
  factual: '#34d399',
  adversarial: '#fbbf24',
  bias: '#a78bfa',
};
const CAT_LABEL: Record<string, string> = {
  factual: 'Hallucination',
  adversarial: 'Content Safety',
  bias: 'Bias & Harmful',
};
const CAT_LABEL_SHORT: Record<string, string> = {
  factual: 'hallucination',
  adversarial: 'content safety',
  bias: 'bias & harmful',
};

const PROVIDER_DISPLAY: Record<string, string> = {
  gemini: '✦ Gemini',
  groq: '⚡ Groq',
  openrouter: '⇆ OpenRouter',
  hf: '🤗 Hugging Face',
  ollama: '🦙 Ollama',
};
function fmtProvider(p: string): string {
  return PROVIDER_DISPLAY[p] ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : p);
}

interface ProviderRoll {
  provider: Provider;
  model: string;
  byCategory: Record<string, { n: number; heur: number; judge: number | null; refusals: number; leaks: number; errors: number }>;
  totalLatencyMs: number;
  totalCalls: number;
}

function roll(results: PromptResult[]): ProviderRoll[] {
  const out = new Map<Provider, ProviderRoll>();
  for (const r of results) {
    let row = out.get(r.provider);
    if (!row) {
      row = { provider: r.provider, model: r.model, byCategory: {}, totalLatencyMs: 0, totalCalls: 0 };
      out.set(r.provider, row);
    }
    const cat = (row.byCategory[r.category] ??= { n: 0, heur: 0, judge: null, refusals: 0, leaks: 0, errors: 0 });
    cat.n += 1;
    cat.heur += r.heuristic.score;
    if (r.judge) cat.judge = (cat.judge ?? 0) + r.judge.score;
    if (r.heuristic.refused) cat.refusals += 1;
    if (r.heuristic.leaked) cat.leaks += 1;
    if (r.errored) cat.errors += 1;
    row.totalCalls += 1;
    row.totalLatencyMs += r.latencyMs;
  }
  return Array.from(out.values()).sort((a, b) => a.provider.localeCompare(b.provider));
}

function pct(x: number): number {
  return Math.round(x * 100);
}
function avgScore(row: ProviderRoll): number {
  const scores = CAT_ORDER.map((c) => row.byCategory[c]).filter(Boolean).map((c) => c!.heur / c!.n);
  if (scores.length === 0) return 0;
  return scores.reduce((s, v) => s + v, 0) / scores.length;
}

function renderChart(rolled: ProviderRoll[]): string {
  const rowHeight = 78;
  const labelWidth = 175;
  const chartWidth = 440;
  const barAreaWidth = chartWidth - 30;
  const groupHeight = 14;
  const groupGap = 4;
  const height = rolled.length * rowHeight + 50;

  const bars: string[] = [];
  rolled.forEach((row, ri) => {
    const yBase = 30 + ri * rowHeight;
    const shortModel = row.model.length > 22 ? row.model.slice(0, 22) + '…' : row.model;
    bars.push(
      `<text x="0" y="${yBase - 18}" font-family="ui-sans-serif,system-ui" font-size="13" font-weight="600" fill="#e9ebf2">${fmtProvider(row.provider)}</text>`,
      `<text x="0" y="${yBase - 4}" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="10" fill="#5c6173">${shortModel}</text>`,
    );
    CAT_ORDER.forEach((cat, ci) => {
      const stat = row.byCategory[cat];
      if (!stat) return;
      const y = yBase + ci * (groupHeight + groupGap);
      const value = stat.heur / stat.n;
      const barX = labelWidth;
      const w = Math.max(2, value * barAreaWidth);
      bars.push(
        `<rect x="${barX}" y="${y}" width="${barAreaWidth}" height="${groupHeight}" rx="3" fill="#1f2330"/>`,
        `<rect x="${barX}" y="${y}" width="${w}" height="${groupHeight}" rx="3" fill="${CAT_COLOR[cat]}"/>`,
        `<text x="${barX + barAreaWidth + 6}" y="${y + 11}" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="11" font-weight="600" fill="#e9ebf2">${pct(value)}%</text>`,
        `<text x="${barX - 6}" y="${y + 11}" text-anchor="end" font-family="ui-sans-serif,system-ui" font-size="10" fill="#8b91a4">${CAT_LABEL_SHORT[cat]}</text>`,
      );
    });
  });

  return `<svg viewBox="0 0 ${chartWidth + labelWidth + 30} ${height}" style="width:100%;height:auto" role="img" aria-label="Per-provider scores by category">${bars.join('')}</svg>`;
}

const CLOCK_ICON =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>';

function renderSummary(rolled: ProviderRoll[]): string {
  return rolled
    .map((r) => {
      const overall = avgScore(r);
      const latency = r.totalCalls ? Math.round(r.totalLatencyMs / r.totalCalls) : 0;
      const scoreTier = overall >= 0.7 ? 'good' : overall >= 0.4 ? 'mid' : 'bad';
      const latencyTier = latency < 500 ? 'good' : latency <= 2000 ? 'mid' : 'bad';
      return `<div class="tile">
  <div class="tile-name">${fmtProvider(r.provider)}</div>
  <div class="tile-score score-${scoreTier}">${pct(overall)}<span>%</span></div>
  <div class="tile-sub sub-${latencyTier}">${CLOCK_ICON}<span>${latency} ms avg</span></div>
</div>`;
    })
    .join('\n');
}

function renderRecommendation(rolled: ProviderRoll[]): string {
  if (rolled.length === 0) return 'No providers ran successfully.';
  const sorted = [...rolled].sort((a, b) => avgScore(b) - avgScore(a));
  const best = sorted[0]!;
  const worst = sorted[sorted.length - 1]!;
  if (rolled.length === 1) {
    return `Only one provider in this run (<b>${fmtProvider(best.provider)}</b> at ${pct(avgScore(best))}%). Add more keys to compare.`;
  }
  const winsBy = pct(avgScore(best)) - pct(avgScore(worst));
  return `<b>${fmtProvider(best.provider)}</b> leads at ${pct(avgScore(best))}%, ${winsBy}pp ahead of <b>${fmtProvider(worst.provider)}</b> at ${pct(avgScore(worst))}%. Use alongside the live dashboard for latency/cost context.`;
}

function renderSafety(results: PromptResult[]): string {
  const map = new Map<string, { provider: string; blocks: number; refusals: number; leaks: number; n: number }>();
  for (const r of results) {
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
  const rows = Array.from(map.values()).sort(
    (a, b) => b.leaks - a.leaks || a.provider.localeCompare(b.provider),
  );
  const body = rows
    .map(
      (row) => `<tr>
  <td>${fmtProvider(row.provider)}</td>
  <td class="num">${row.blocks}</td>
  <td class="num">${row.refusals}</td>
  <td class="num ${row.leaks > 0 ? 'bad' : 'ok'}">${row.leaks}</td>
  <td class="num muted">${row.n}</td>
</tr>`,
    )
    .join('\n');
  return `<table class="safety-table">
  <thead>
    <tr>
      <th>Provider</th>
      <th>Ingress blocks</th>
      <th>Model refusals</th>
      <th>Leak markers</th>
      <th>Prompts</th>
    </tr>
  </thead>
  <tbody>${body}</tbody>
</table>`;
}

export function renderInfographic({ results, judge }: ReportInput): string {
  const rolled = roll(results);
  const date = new Date().toISOString().slice(0, 10);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>LLM Evaluation Report — ${date}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: #0a0c11; color: #e9ebf2;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 12px; line-height: 1.45;
  }
  body { padding: 22px 26px; }
  .row { display: flex; gap: 14px; }
  .header {
    display: flex; justify-content: space-between; align-items: flex-end;
    border-bottom: 1px solid #262b38; padding-bottom: 10px; margin-bottom: 16px;
  }
  h1 {
    font-size: 19px; letter-spacing: -0.01em;
    background: linear-gradient(135deg,#e9ebf2,#a78bfa); -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .eyebrow { font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: #5c6173; font-weight: 600; }
  .meta { font-size: 10.5px; color: #8b91a4; text-align: right; }
  .meta code { background: #14171f; padding: 2px 5px; border-radius: 4px; }
  .panel {
    background: #14171f; border: 1px solid #262b38; border-radius: 10px;
    padding: 14px 16px; margin-bottom: 12px;
  }
  .panel h2 {
    font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
    color: #5c6173; font-weight: 600; margin-bottom: 10px;
  }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
  .tile {
    background: #1a1e28; border: 1px solid #20242e; border-radius: 8px;
    padding: 10px 12px;
  }
  .tile-name { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #8b91a4; }
  .tile-score { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; margin-top: 2px; }
  .tile-score span { font-size: 14px; color: #8b91a4; margin-left: 1px; }
  .tile-score.score-good { color: #4ec5a3; }
  .tile-score.score-mid { color: #e5c468; }
  .tile-score.score-bad { color: #e87a7a; }
  .tile-sub { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; color: #8b91a4; font-family: ui-monospace, Menlo, Consolas, monospace; margin-top: 6px; padding: 3px 8px; background: rgba(255,255,255,0.04); border: 1px solid #262b38; border-radius: 6px; }
  .tile-sub.sub-good { color: #4ec5a3; background: rgba(78,197,163,0.1); border-color: rgba(78,197,163,0.28); }
  .tile-sub.sub-mid { color: #9bb7e0; background: rgba(90,163,212,0.08); border-color: rgba(90,163,212,0.22); }
  .tile-sub.sub-bad { color: #e5a468; background: rgba(229,164,104,0.1); border-color: rgba(229,164,104,0.26); }
  .safety { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .safety > div {
    display: flex; align-items: baseline; gap: 8px;
    background: #1a1e28; border: 1px solid #20242e; border-radius: 8px; padding: 10px 12px;
  }
  .safety .big { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
  .safety .label { font-size: 10px; color: #8b91a4; }
  .safety-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  .safety-table th, .safety-table td { padding: 7px 9px; text-align: left; border-bottom: 1px solid #20242e; }
  .safety-table th { font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: #8b91a4; font-weight: 700; }
  .safety-table tbody tr:last-child td { border-bottom: none; }
  .safety-table .num { text-align: right; font-family: ui-monospace, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; font-weight: 600; }
  .safety-table .num.bad { color: #e87a7a; }
  .safety-table .num.ok { color: #2ba884; }
  .safety-table .num.muted { color: #5c6173; font-weight: 500; }
  .reco { font-size: 13px; color: #e9ebf2; }
  .reco b { color: #a78bfa; }
  .legend { display: inline-flex; gap: 12px; font-size: 10.5px; color: #8b91a4; margin-top: 6px; }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .legend i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .footer { font-size: 9.5px; color: #5c6173; margin-top: 8px; }
  .footer b { color: #8b91a4; }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="eyebrow">LLM Observability — Evaluation</div>
    <h1>Cross-Provider Assistant Evaluation</h1>
  </div>
  <div class="meta">
    Generated <code>${date}</code><br/>
    Judge: <code>${judge ? `${fmtProvider(judge.provider)}/${judge.model}` : 'heuristics only'}</code>
  </div>
</div>

<div class="panel">
  <h2>TL;DR</h2>
  <div class="reco">${renderRecommendation(rolled)}</div>
</div>

<div class="panel">
  <h2>Overall heuristic score per provider</h2>
  <div class="tiles">${renderSummary(rolled)}</div>
</div>

<div class="panel">
  <h2>Per-category breakdown</h2>
  ${renderChart(rolled)}
  <div class="legend">
    <span><i style="background:${CAT_COLOR.factual}"></i>${CAT_LABEL.factual}</span>
    <span><i style="background:${CAT_COLOR.adversarial}"></i>${CAT_LABEL.adversarial}</span>
    <span><i style="background:${CAT_COLOR.bias}"></i>${CAT_LABEL.bias}</span>
  </div>
</div>

<div class="panel">
  <h2>Safety signals</h2>
  ${renderSafety(results)}
</div>

<div class="footer">
  <b>Method:</b> 30 prompts (10 factual / 10 adversarial / 10 bias) sent to each provider at temperature 0.
  Heuristic scoring via regex (keyword match for factual, refusal-pattern detection for adversarial, hedging-vocabulary for bias).
  ${judge ? `LLM judge rates each response 0..1 with a fixed rubric using <code>${fmtProvider(judge.provider)}/${judge.model}</code>.` : ''}
  Guardrails layer is pattern-based and runs <i>before</i> the model — blocked prompts are reported separately so we see what the wrapper caught vs. what the model handled.
  Open in a browser and use <b>Print → Save as PDF</b> to produce the 1-page deliverable.
</div>

</body>
</html>`;
}
