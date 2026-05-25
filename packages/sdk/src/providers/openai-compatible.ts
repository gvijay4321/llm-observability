import type { Provider } from '@obs/shared';
import type { GenerateRequest, GenerateResult, LLMProvider, ProviderUsage, StreamChunk } from './types.js';
import { assertOk, parseSSE } from './sse.js';

// Adapter for any API that speaks OpenAI's Chat Completions wire format.
// We use it for Groq, OpenRouter, HuggingFace Inference, and Ollama — NOT for
// OpenAI the company (not a supported provider here). Gemini gets its own
// adapter in gemini.ts because Google uses a different wire format.

export interface OpenAICompatibleOptions {
  baseUrl: string;
  name: Provider;
  // Ollama etc. run keyless.
  allowEmptyKey?: boolean;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

function toUsage(u: OpenAIUsage | undefined): ProviderUsage | undefined {
  if (!u) return undefined;
  const prompt = u.prompt_tokens ?? 0;
  const completion = u.completion_tokens ?? 0;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: u.total_tokens ?? prompt + completion };
}

function toMessages(req: GenerateRequest) {
  const msgs: Array<{ role: string; content: string }> = [];
  if (req.systemPrompt) msgs.push({ role: 'system', content: req.systemPrompt });
  for (const m of req.messages) msgs.push({ role: m.role, content: m.content });
  return msgs;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: Provider;
  private readonly baseUrl: string;

  constructor(private readonly apiKey: string, opts: OpenAICompatibleOptions) {
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    if (!apiKey && !opts.allowEmptyKey) {
      throw new Error(`${this.name} provider requires an API key`);
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  // Make "fetch failed" actionable, especially for ollama-not-running.
  private async safeFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      const hint =
        this.name === 'ollama'
          ? `is the Ollama daemon running at ${this.baseUrl}? Start it with 'ollama serve' or install from https://ollama.com.`
          : this.name === 'hf'
            ? `could not reach the Hugging Face router at ${this.baseUrl}. Check HF_TOKEN and network access.`
            : `could not reach the ${this.name} API at ${this.baseUrl}.`;
      throw new Error(`${this.name} connection failed: ${hint}`, { cause: err });
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const res = await this.safeFetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: req.model,
        messages: toMessages(req),
        temperature: req.temperature,
        max_tokens: req.maxTokens,
      }),
      signal: req.signal,
    });
    await assertOk(res, this.name);
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: OpenAIUsage;
    };
    const choice = json.choices?.[0];
    return {
      text: choice?.message?.content ?? '',
      usage: toUsage(json.usage),
      finishReason: choice?.finish_reason,
    };
  }

  async *generateStream(req: GenerateRequest): AsyncIterable<StreamChunk> {
    const res = await this.safeFetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: req.model,
        messages: toMessages(req),
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: req.signal,
    });
    await assertOk(res, this.name);

    for await (const raw of parseSSE(res)) {
      const json = raw as {
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
        usage?: OpenAIUsage;
      };
      const choice = json.choices?.[0];
      yield {
        textDelta: choice?.delta?.content ?? '',
        usage: toUsage(json.usage),
        finishReason: choice?.finish_reason ?? undefined,
      };
    }
  }
}
