import type { Provider } from '@obs/shared';
import type { LLMProvider } from './types.js';
import { GeminiProvider } from './gemini.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

export * from './types.js';
export { GeminiProvider, OpenAICompatibleProvider };

// All four speak OpenAI's Chat Completions wire format.
const OPENAI_COMPATIBLE: Partial<Record<Provider, string>> = {
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  hf: 'https://router.huggingface.co/v1',
  ollama: 'http://localhost:11434/v1',
};

export interface ProviderFactoryOptions {
  provider: Provider;
  apiKey?: string;
}

export function createProvider({ provider, apiKey }: ProviderFactoryOptions): LLMProvider {
  if (provider === 'gemini') return new GeminiProvider(apiKey ?? '');
  const baseUrl = OPENAI_COMPATIBLE[provider];
  if (!baseUrl) throw new Error(`Unknown provider: ${provider}`);
  return new OpenAICompatibleProvider(apiKey ?? '', {
    baseUrl,
    name: provider,
    allowEmptyKey: provider === 'ollama',
  });
}
