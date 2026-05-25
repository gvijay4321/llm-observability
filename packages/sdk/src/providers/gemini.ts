import type { Provider } from '@obs/shared';
import type { GenerateRequest, GenerateResult, LLMProvider, ProviderUsage, StreamChunk } from './types.js';
import { assertOk, parseSSE } from './sse.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

function toContents(req: GenerateRequest) {
  return req.messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

function toUsage(u: GeminiResponse['usageMetadata']): ProviderUsage | undefined {
  if (!u) return undefined;
  const prompt = u.promptTokenCount ?? 0;
  const completion = u.candidatesTokenCount ?? 0;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: u.totalTokenCount ?? prompt + completion };
}

function buildBody(req: GenerateRequest) {
  return {
    contents: toContents(req),
    ...(req.systemPrompt ? { systemInstruction: { parts: [{ text: req.systemPrompt }] } } : {}),
    generationConfig: {
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
    },
  };
}

export class GeminiProvider implements LLMProvider {
  readonly name: Provider = 'gemini';

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('GeminiProvider requires an API key (GEMINI_API_KEY)');
  }

  private headers() {
    return { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const res = await fetch(`${BASE}/models/${req.model}:generateContent`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(buildBody(req)),
      signal: req.signal,
    });
    await assertOk(res, 'gemini');
    const json = (await res.json()) as GeminiResponse;
    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    return { text, usage: toUsage(json.usageMetadata), finishReason: candidate?.finishReason };
  }

  async *generateStream(req: GenerateRequest): AsyncIterable<StreamChunk> {
    const res = await fetch(`${BASE}/models/${req.model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(buildBody(req)),
      signal: req.signal,
    });
    await assertOk(res, 'gemini');

    for await (const raw of parseSSE(res)) {
      const json = raw as GeminiResponse;
      const candidate = json.candidates?.[0];
      const textDelta = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      yield { textDelta, usage: toUsage(json.usageMetadata), finishReason: candidate?.finishReason };
    }
  }
}
