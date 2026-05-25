// tsx scripts/eval/run.ts [--providers gemini,hf,...] [--no-judge] [--out path]
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import type { Provider } from '@obs/shared';
import { createProvider, type LLMProvider } from '@obs/sdk';
import { PROMPTS, type Category, type EvalPrompt } from './prompts.js';
import { scoreHeuristic, type HeuristicScore } from './score.js';
import { makeJudge, type JudgeVerdict } from './judge.js';
import { checkPrompt } from '../../apps/chatbot/lib/guardrails.js';
import { renderReport } from './report.js';
import { renderInfographic } from './infographic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
loadEnv({ path: resolve(REPO_ROOT, '.env') });

interface CliArgs {
  providers?: Provider[];
  useJudge: boolean;
  outDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { useJudge: true, outDir: resolve(REPO_ROOT, 'eval-results') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--providers') args.providers = argv[++i]!.split(',') as Provider[];
    else if (a === '--no-judge') args.useJudge = false;
    else if (a === '--out') args.outDir = resolve(argv[++i]!);
  }
  return args;
}

interface ProviderTarget {
  name: Provider;
  model: string;
  client: LLMProvider;
}

const MODELS: Record<Provider, string> = {
  gemini: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  groq: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
  openrouter: process.env.OPENROUTER_MODEL ?? 'meta-llama/llama-3.3-70b-instruct:free',
  hf: process.env.HF_MODEL ?? 'Qwen/Qwen2.5-7B-Instruct',
  ollama: process.env.OLLAMA_MODEL ?? 'qwen2.5:7b',
};

const ENV_KEY: Record<Provider, string | null> = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  hf: 'HF_TOKEN',
  ollama: null,
};

function resolveTargets(want?: Provider[]): ProviderTarget[] {
  const candidates: Provider[] = want ?? ['gemini', 'groq', 'openrouter', 'hf', 'ollama'];
  const targets: ProviderTarget[] = [];
  for (const name of candidates) {
    const envVar = ENV_KEY[name];
    const apiKey = envVar ? (process.env[envVar] ?? '') : '';
    if (envVar && !apiKey && name !== 'ollama') {
      process.stderr.write(`[eval] skipping ${name}: ${envVar} not set\n`);
      continue;
    }
    try {
      const client = createProvider({ provider: name, apiKey });
      targets.push({ name, model: MODELS[name], client });
    } catch (err) {
      process.stderr.write(`[eval] cannot init ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return targets;
}

interface PromptResult {
  promptId: string;
  category: Category;
  provider: Provider;
  model: string;
  blockedByGuardrails: boolean;
  guardrailsCategory?: string;
  response: string;
  latencyMs: number;
  errored: boolean;
  errorMessage?: string;
  heuristic: HeuristicScore;
  judge?: JudgeVerdict;
}

async function runOne(p: EvalPrompt, t: ProviderTarget): Promise<Omit<PromptResult, 'heuristic' | 'judge'>> {
  // Same guardrails the chat route runs.
  const verdict = checkPrompt(p.prompt);
  if (!verdict.allowed) {
    return {
      promptId: p.id,
      category: p.category,
      provider: t.name,
      model: t.model,
      blockedByGuardrails: true,
      guardrailsCategory: verdict.block?.category,
      response: `[GUARDRAILS REFUSAL: ${verdict.block?.reason ?? 'blocked'}]`,
      latencyMs: 0,
      errored: false,
    };
  }
  const t0 = Date.now();
  try {
    const result = await t.client.generate({
      model: t.model,
      messages: [{ role: 'user', content: p.prompt }],
      temperature: 0,
      maxTokens: 600,
    });
    return {
      promptId: p.id,
      category: p.category,
      provider: t.name,
      model: t.model,
      blockedByGuardrails: false,
      response: result.text || '(empty response)',
      latencyMs: Date.now() - t0,
      errored: false,
    };
  } catch (err) {
    return {
      promptId: p.id,
      category: p.category,
      provider: t.name,
      model: t.model,
      blockedByGuardrails: false,
      response: '',
      latencyMs: Date.now() - t0,
      errored: true,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = resolveTargets(args.providers);
  if (targets.length === 0) {
    process.stderr.write('[eval] no providers available. Configure at least one API key in .env\n');
    process.exit(1);
  }
  process.stdout.write(`[eval] running ${PROMPTS.length} prompts × ${targets.length} providers = ${PROMPTS.length * targets.length} calls\n`);
  process.stdout.write(`[eval] providers: ${targets.map((t) => `${t.name}/${t.model}`).join(', ')}\n`);

  const judge = args.useJudge ? makeJudge() : null;
  if (args.useJudge) {
    if (judge) process.stdout.write(`[eval] LLM judge: ${judge.identity.provider}/${judge.identity.model}\n`);
    else process.stdout.write('[eval] no judge configured (set GEMINI_API_KEY)\n');
  }

  const results: PromptResult[] = [];
  for (const t of targets) {
    process.stdout.write(`\n[eval] ${t.name}/${t.model}\n`);
    for (const p of PROMPTS) {
      process.stdout.write(`  ${p.id} ${p.category.padEnd(11)} `);
      const raw = await runOne(p, t);
      const heuristic = scoreHeuristic(p, raw.response);
      let judged: JudgeVerdict | undefined;
      // Skip self-grading: if the target provider is also the judge, the judge
      // can't be neutral about its own family. Heuristic still covers every row.
      if (judge && !raw.errored && judge.identity.provider !== t.name) {
        judged = await judge.rate(p, raw.response);
      }
      const result: PromptResult = { ...raw, heuristic, judge: judged };
      results.push(result);
      const judgeNote = judged ? ` judge=${judged.score.toFixed(2)}` : '';
      process.stdout.write(
        `${raw.errored ? 'ERR' : raw.blockedByGuardrails ? 'GUARD' : 'OK '} ` +
          `heur=${heuristic.score.toFixed(2)}${judgeNote} ` +
          `(${raw.latencyMs}ms)\n`,
      );
    }
  }

  const generatedAt = new Date().toISOString();
  const ts = generatedAt.replace(/[:.]/g, '-');
  await mkdir(args.outDir, { recursive: true });
  const jsonPath = resolve(args.outDir, `${ts}.json`);
  const mdPath = resolve(args.outDir, `${ts}.md`);
  const htmlPath = resolve(args.outDir, `${ts}.html`);
  const html = renderInfographic({ results, judge: judge?.identity ?? null });
  const payload = JSON.stringify({ generatedAt, judge: judge?.identity ?? null, results }, null, 2);
  await writeFile(jsonPath, payload);
  await writeFile(mdPath, renderReport({ results, judge: judge?.identity ?? null }));
  await writeFile(htmlPath, html);
  // Also publish the latest run's raw JSON to the chatbot's public/ so the in-app
  // /eval page can render it natively (must be committed to git so Railway ships it).
  const publicDir = resolve(REPO_ROOT, 'apps/chatbot/public');
  await mkdir(publicDir, { recursive: true });
  const publicJsonPath = resolve(publicDir, 'eval-latest.json');
  await writeFile(publicJsonPath, payload);
  process.stdout.write(`\n[eval] wrote\n  ${jsonPath}\n  ${mdPath}\n  ${htmlPath}\n  ${publicJsonPath}  (served at /eval-latest.json — commit to ship with Railway build)\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

export type { PromptResult };
