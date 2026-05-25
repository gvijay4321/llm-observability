import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import type { Provider } from '@obs/shared';

// Next only auto-loads .env from the app folder.
loadEnv({ path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')] });

// First entry is default; <PROVIDER>_MODEL env vars override.
const MODEL_CATALOG: Record<Provider, string[]> = {
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'],
  openrouter: [
    // OpenRouter rotates free endpoints; refresh from /api/v1/models if 404s show up.
    'meta-llama/llama-3.3-70b-instruct:free',
    'openai/gpt-oss-120b:free',
    'qwen/qwen3-next-80b-a3b-instruct:free',
  ],
  // No mistral-v0.3; HF returns "not a chat model".
  hf: ['Qwen/Qwen2.5-7B-Instruct', 'meta-llama/Meta-Llama-3-8B-Instruct'],
  ollama: ['qwen2.5:7b', 'llama3.2:3b', 'mistral:7b'],
};

const ENV_KEY: Record<Provider, string> = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  hf: 'HF_TOKEN',
  ollama: '',
};

const SELECTABLE: Provider[] = ['gemini', 'groq', 'openrouter', 'hf', 'ollama'];

function resolveDefaultProvider(): Provider {
  const env = process.env.LLM_PROVIDER;
  if (!env) return 'gemini';
  if ((SELECTABLE as string[]).includes(env)) return env as Provider;
  console.warn(
    `[config] LLM_PROVIDER="${env}" is not a known provider (${SELECTABLE.join(', ')}); falling back to gemini.`,
  );
  return 'gemini';
}

const defaultProvider = resolveDefaultProvider();

export interface ProviderConfig {
  provider: Provider;
  model: string;
  apiKey: string;
}

export function providerModels(provider: Provider): string[] {
  const envModel = process.env[`${provider.toUpperCase()}_MODEL`];
  const legacyModel = provider === defaultProvider ? process.env.LLM_MODEL : undefined;
  const override = envModel ?? legacyModel;
  const catalog = MODEL_CATALOG[provider];
  if (override && !catalog.includes(override)) return [override, ...catalog];
  if (override) return [override, ...catalog.filter((m) => m !== override)];
  return catalog;
}

export function isAllowedModel(provider: Provider, model: string): boolean {
  return providerModels(provider).includes(model);
}

export function providerConfig(provider: Provider): ProviderConfig {
  const keyVar = ENV_KEY[provider];
  return {
    provider,
    model: providerModels(provider)[0]!,
    apiKey: keyVar ? process.env[keyVar] ?? '' : '',
  };
}

export function availableProviders(): Provider[] {
  return SELECTABLE.filter((p) => {
    if (p === 'ollama') return true;
    return providerConfig(p).apiKey.length > 0;
  });
}

// Railway sets OLLAMA_AVAILABLE=false; no GPU/daemon there.
export function isOllamaReachable(): boolean {
  return process.env.OLLAMA_AVAILABLE !== 'false';
}

export function unreachableProviders(): Provider[] {
  return isOllamaReachable() ? [] : ['ollama'];
}

export function defaultSelectableProvider(): Provider {
  const available = availableProviders();
  const unreachable = new Set(unreachableProviders());
  const reachable = available.filter((p) => !unreachable.has(p));
  const pool = reachable.length > 0 ? reachable : available;
  return pool.includes(defaultProvider) ? defaultProvider : pool[0]!;
}

// Server-only; do not import from client components.
export const serverConfig = {
  ingestionUrl: (process.env.INGESTION_URL ?? 'http://localhost:4000').replace(/\/$/, ''),
  ingestionApiKey: process.env.INGESTION_API_KEY ?? '',
  systemPrompt:
    'You are a concise, helpful assistant inside an observability demo app. ' +
    'Keep answers focused and friendly.',
} as const;
