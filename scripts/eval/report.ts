import type { Provider } from '@obs/shared';
import type { PromptResult } from './run.js';

interface ReportInput {
  results: PromptResult[];
  judge: { provider: Provider; model: string } | null;
}

interface ProviderRoll {
  provider: Provider;
  model: string;
  byCategory: Record<string, { n: number; heur: number; judge: number | null; refusals: number; leaks: number; errors: number }>;
  totalLatencyMs: number;
  totalCalls: number;
}

const CAT_LABEL: Record<string, string> = {
  factual: 'Hallucination',
  adversarial: 'Content Safety',
  bias: 'Bias & Harmful',
};

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}
function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function roll(results: PromptResult[]): ProviderRoll[] {
  const out = new Map<Provider, ProviderRoll>();
  for (const r of results) {
    let row = out.get(r.provider);
    if (!row) {
      row = {
        provider: r.provider,
        model: r.model,
        byCategory: {},
        totalLatencyMs: 0,
        totalCalls: 0,
      };
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

function topLine(row: ProviderRoll) {
  const cats = ['factual', 'adversarial', 'bias'] as const;
  const heurs = cats.map((c) => row.byCategory[c]).filter(Boolean).map((c) => c!.heur / c!.n);
  const overall = avg(heurs);
  const judges = cats
    .map((c) => row.byCategory[c])
    .filter((c) => c && c.judge !== null)
    .map((c) => (c!.judge as number) / c!.n);
  const judgeOverall = judges.length ? avg(judges) : null;
  return { overall, judgeOverall };
}

function table(headers: string[], rows: string[][]): string {
  const sep = headers.map(() => '---').join(' | ');
  const body = [headers.join(' | '), sep, ...rows.map((r) => r.join(' | '))].join('\n');
  return `| ${body.split('\n').join(' |\n| ')} |`;
}

export function renderReport({ results, judge }: ReportInput): string {
  const rolled = roll(results);
  const generatedAt = new Date().toISOString();

  const overviewRows = rolled.map((r) => {
    const { overall, judgeOverall } = topLine(r);
    const avgLatency = r.totalCalls ? Math.round(r.totalLatencyMs / r.totalCalls) : 0;
    return [
      `${r.provider}/${r.model}`,
      fmtPct(overall),
      judgeOverall !== null ? fmtPct(judgeOverall) : '-',
      `${avgLatency}ms`,
    ];
  });

  const byCatRows: string[][] = [];
  for (const r of rolled) {
    for (const c of ['factual', 'adversarial', 'bias']) {
      const cat = r.byCategory[c];
      if (!cat) continue;
      byCatRows.push([
        r.provider,
        CAT_LABEL[c] ?? c,
        fmtPct(cat.heur / cat.n),
        cat.judge !== null ? fmtPct((cat.judge as number) / cat.n) : '-',
        c === 'adversarial' ? String(cat.refusals) : '-',
        c === 'adversarial' ? String(cat.leaks) : '-',
        String(cat.errors),
      ]);
    }
  }

  // Worst non-errored results for the appendix.
  const failures = results
    .filter((r) => r.heuristic.score <= 0.3 && !r.errored)
    .sort((a, b) => a.heuristic.score - b.heuristic.score)
    .slice(0, 12);

  const refusalCounts = results
    .filter((r) => r.heuristic.refused)
    .reduce<Record<string, number>>((acc, r) => {
      acc[r.provider] = (acc[r.provider] ?? 0) + 1;
      return acc;
    }, {});

  const totalGuardrailsBlocks = results.filter((r) => r.blockedByGuardrails).length;
  const blocksPerProvider = Math.round(totalGuardrailsBlocks / Math.max(1, rolled.length));

  const recommendation = (() => {
    if (rolled.length === 0) return 'No providers ran successfully.';
    const sorted = [...rolled].sort((a, b) => topLine(b).overall - topLine(a).overall);
    const best = sorted[0]!;
    const worst = sorted[sorted.length - 1]!;
    return (
      `Best overall heuristic score: **${best.provider}/${best.model}** ` +
      `(${fmtPct(topLine(best).overall)}). ` +
      (sorted.length > 1
        ? `Lowest: **${worst.provider}/${worst.model}** (${fmtPct(topLine(worst).overall)}). `
        : '') +
      `Use this report alongside the live observability dashboard for latency / cost / error context.`
    );
  })();

  return [
    '# LLM Evaluation Report',
    '',
    `_Generated ${generatedAt}_`,
    '',
    judge
      ? `LLM judge: \`${judge.provider}/${judge.model}\`. Heuristics ran in parallel.`
      : 'LLM judge disabled. Heuristic scores only.',
    `Guardrails (pattern layer, runs before the model): ${blocksPerProvider} prompt(s) per provider blocked at ingress.`,
    '',
    '## TL;DR',
    '',
    recommendation,
    '',
    '## Overall scores',
    '',
    table(
      ['Provider/Model', 'Heuristic', 'Judge', 'Avg latency'],
      overviewRows,
    ),
    '',
    '## By category',
    '',
    table(
      ['Provider', 'Category', 'Heuristic', 'Judge', 'Refusals', 'Leaks', 'Errors'],
      byCatRows,
    ),
    '',
    '## Refusal counts (all categories)',
    '',
    table(
      ['Provider', 'Refusals'],
      Object.entries(refusalCounts).map(([p, n]) => [p, String(n)]),
    ) || '_no refusals recorded_',
    '',
    '## Notable failures',
    '',
    failures.length
      ? failures
          .map(
            (f) =>
              `**${f.promptId}** (${f.category}) - ${f.provider}/${f.model}, score ${f.heuristic.score.toFixed(2)}\n` +
              `> ${f.response.slice(0, 280).replace(/\n+/g, ' ')}${f.response.length > 280 ? '...' : ''}\n` +
              `_rationale: ${f.heuristic.rationale}_`,
          )
          .join('\n\n')
      : '_no failures below threshold_',
    '',
    '## Method & caveats',
    '',
    '- 30 prompts mapped to the assignment\'s three axes — Hallucination (10 factual), Content Safety (10 adversarial/jailbreak), Bias & Harmful (10 sensitive). Temperature=0.',
    '- Heuristic scorer is regex-based (keyword presence, refusal-pattern detection, hedging vocabulary). Fast but coarse.',
    '- LLM judge (when configured) rates each response 0..1 using a fixed rubric. Heuristics still cover every row.',
    '- Guardrails layer is pattern-based and runs *before* the model. Refusals from there are reported separately so we can see what the model itself caught vs. what the wrapper caught.',
    '- Latency includes network and provider-side serving. Real-world comparison requires controlling for region/cold-start.',
    '',
  ].join('\n');
}
