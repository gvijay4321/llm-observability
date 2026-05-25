import type { TokenUsage } from './types.js';

// Rough USD per 1M tokens. Prices drift; treat as a signal, not a bill.
interface Price {
  inputPerM: number;
  outputPerM: number;
}

const PRICING: Record<string, Price> = {
  'gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5 },
  'gemini-2.5-flash-lite': { inputPerM: 0.1, outputPerM: 0.4 },
  'gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10.0 },
  // Free tiers below.
  'llama-3.3-70b-versatile': { inputPerM: 0, outputPerM: 0 },
  'llama-3.1-8b-instant': { inputPerM: 0, outputPerM: 0 },
  'gemma2-9b-it': { inputPerM: 0, outputPerM: 0 },
  'meta-llama/llama-3.3-70b-instruct:free': { inputPerM: 0, outputPerM: 0 },
  'openai/gpt-oss-120b:free': { inputPerM: 0, outputPerM: 0 },
  'qwen/qwen3-next-80b-a3b-instruct:free': { inputPerM: 0, outputPerM: 0 },
};

export function estimateCostUsd(model: string, usage: TokenUsage | undefined): number | null {
  if (!usage) return null;
  const price = PRICING[model] ?? PRICING[model.toLowerCase()];
  if (!price) return null;
  const cost =
    (usage.promptTokens / 1_000_000) * price.inputPerM +
    (usage.completionTokens / 1_000_000) * price.outputPerM;
  return Math.round(cost * 1e6) / 1e6;
}
