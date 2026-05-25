import { describe, expect, it } from 'vitest';
import type { InferenceLog, Provider } from '@obs/shared';
import { ObservableLLM } from './client.js';
import type { GenerateRequest, GenerateResult, LLMProvider, StreamChunk } from './providers/index.js';
import type { LogShipper } from './transport.js';

interface FakeOptions {
  failureRate?: number;
}

// Deterministic in-test stand-in for the SDK's network providers. Lives here
// instead of in providers/ because nothing in the shipped SDK should depend
// on a "fake" provider.
class FakeProvider implements LLMProvider {
  readonly name: Provider = 'gemini';
  private readonly failureRate: number;
  constructor(opts: FakeOptions = {}) {
    this.failureRate = opts.failureRate ?? 0;
  }
  private reply(req: GenerateRequest): string {
    const last = req.messages[req.messages.length - 1]?.content ?? '';
    return `(fake reply) You said: "${last.slice(0, 80)}".`;
  }
  private maybeFail(): void {
    if (Math.random() < this.failureRate) {
      const e = new Error('Simulated upstream provider error');
      e.name = 'ProviderError';
      throw e;
    }
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    await delay(20, req.signal);
    this.maybeFail();
    const text = this.reply(req);
    return {
      text,
      usage: { promptTokens: 5, completionTokens: 8, totalTokens: 13 },
      finishReason: 'stop',
    };
  }
  async *generateStream(req: GenerateRequest): AsyncIterable<StreamChunk> {
    this.maybeFail();
    const words = this.reply(req).split(' ');
    await delay(20, req.signal);
    for (let i = 0; i < words.length; i++) {
      await delay(5, req.signal);
      yield { textDelta: i === 0 ? words[i]! : ` ${words[i]}` };
    }
    yield {
      textDelta: '',
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 8, totalTokens: 13 },
    };
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(abortError());
    });
  });
}

function abortError(): Error {
  const e = new Error('Request aborted');
  e.name = 'AbortError';
  return e;
}

function makeLLM(failureRate = 0) {
  const logs: InferenceLog[] = [];
  const shipper = {
    enqueue: (log: InferenceLog) => void logs.push(log),
    flush: async () => undefined,
    close: async () => undefined,
  } as unknown as LogShipper;

  const llm = new ObservableLLM({
    provider: new FakeProvider({ failureRate }),
    defaultModel: 'gemini-2.5-flash',
    shipper,
  });
  return { llm, logs };
}

const context = { conversationId: 'conv-1', sessionId: 'sess-1' };

describe('ObservableLLM.chat', () => {
  it('returns a completion and emits one success log', async () => {
    const { llm, logs } = makeLLM();
    const result = await llm.chat({ ...context, messages: [{ role: 'user', content: 'hello world' }] });

    expect(result.text.length).toBeGreaterThan(0);
    expect(result.usage?.totalTokens).toBeGreaterThan(0);

    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log.status).toBe('success');
    expect(log.provider).toBe('gemini');
    expect(log.streaming).toBe(false);
    expect(log.latencyMs).toBeGreaterThanOrEqual(0);
    expect(log.inputPreview).toContain('hello world');
  });

  it('emits an error log and rethrows when the provider fails', async () => {
    const { llm, logs } = makeLLM(1);
    await expect(
      llm.chat({ ...context, messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow();

    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe('error');
    expect(logs[0]!.error?.type).toBeTruthy();
  });
});

describe('ObservableLLM.chatStream', () => {
  it('streams deltas, finishes with a done event, and logs TTFT', async () => {
    const { llm, logs } = makeLLM();
    let streamed = '';
    let sawDone = false;

    for await (const ev of llm.chatStream({
      ...context,
      messages: [{ role: 'user', content: 'tell me something' }],
    })) {
      if (ev.type === 'delta') streamed += ev.text;
      if (ev.type === 'done') sawDone = true;
    }

    expect(streamed.length).toBeGreaterThan(0);
    expect(sawDone).toBe(true);

    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log.streaming).toBe(true);
    expect(log.status).toBe('success');
    expect(typeof log.ttftMs).toBe('number');
  });

  it('logs a cancelled stream when the caller aborts mid-flight', async () => {
    const { llm, logs } = makeLLM();
    const controller = new AbortController();

    const consume = async () => {
      for await (const ev of llm.chatStream({
        ...context,
        messages: [{ role: 'user', content: 'a fairly long prompt to stream' }],
        signal: controller.signal,
      })) {
        if (ev.type === 'delta') controller.abort();
      }
    };

    await expect(consume()).rejects.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.finishReason).toBe('cancelled');
  });
});
