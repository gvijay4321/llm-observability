import { ObservableLLM, createProvider } from '@obs/sdk';
import type { Provider } from '@obs/shared';
import { providerConfig, serverConfig } from './config';

// One ObservableLLM per provider, lazily built and reused for the process.
const cache = new Map<Provider, ObservableLLM>();

export function getLLM(provider: Provider): ObservableLLM {
  const existing = cache.get(provider);
  if (existing) return existing;

  const cfg = providerConfig(provider);
  const llm = new ObservableLLM({
    provider: createProvider({ provider, apiKey: cfg.apiKey }),
    defaultModel: cfg.model,
    ingestion: {
      url: serverConfig.ingestionUrl,
      apiKey: serverConfig.ingestionApiKey,
      batchSize: 5,
      flushIntervalMs: 1500,
    },
  });
  cache.set(provider, llm);
  return llm;
}
