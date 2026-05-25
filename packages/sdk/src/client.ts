import { randomUUID } from 'node:crypto';
import type { InferenceLog, Provider, TokenUsage } from '@obs/shared';
import { makePreview } from '@obs/shared';
import type { LLMProvider, ProviderMessage, ProviderUsage } from './providers/index.js';
import { LogShipper, type ShipperOptions } from './transport.js';

const SDK_VERSION = '1.0.0';

export interface ObservableLLMOptions {
  provider: LLMProvider;
  defaultModel: string;
  ingestion?: ShipperOptions;
  shipper?: LogShipper;
}

export interface ChatContext {
  conversationId: string;
  sessionId: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatRequest extends ChatContext {
  messages: ProviderMessage[];
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  usage?: TokenUsage;
  finishReason?: string;
  log: InferenceLog;
}

export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string; usage?: TokenUsage; finishReason?: string; log: InferenceLog };

// Wraps a provider and ships an InferenceLog per call. Telemetry must never
// change call behaviour.
export class ObservableLLM {
  private readonly provider: LLMProvider;
  private readonly defaultModel: string;
  private readonly shipper: LogShipper;

  constructor(opts: ObservableLLMOptions) {
    this.provider = opts.provider;
    this.defaultModel = opts.defaultModel;
    this.shipper = opts.shipper ?? new LogShipper(opts.ingestion ?? {});
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const model = req.model ?? this.defaultModel;
    const started = Date.now();
    const requestTimestamp = new Date(started).toISOString();

    try {
      const result = await this.provider.generate({
        model,
        messages: req.messages,
        systemPrompt: req.systemPrompt,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        signal: req.signal,
      });
      const log = this.buildLog({
        req,
        model,
        status: 'success',
        streaming: false,
        latencyMs: Date.now() - started,
        requestTimestamp,
        outputText: result.text,
        usage: result.usage,
        finishReason: result.finishReason,
      });
      this.shipper.enqueue(log);
      return { text: result.text, usage: result.usage, finishReason: result.finishReason, log };
    } catch (err) {
      const log = this.buildErrorLog({ req, model, streaming: false, latencyMs: Date.now() - started, requestTimestamp, err });
      this.shipper.enqueue(log);
      throw err;
    }
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const model = req.model ?? this.defaultModel;
    const started = Date.now();
    const requestTimestamp = new Date(started).toISOString();

    let text = '';
    let ttftMs: number | undefined;
    let usage: ProviderUsage | undefined;
    let finishReason: string | undefined;

    try {
      for await (const chunk of this.provider.generateStream({
        model,
        messages: req.messages,
        systemPrompt: req.systemPrompt,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        signal: req.signal,
      })) {
        if (chunk.textDelta) {
          if (ttftMs === undefined) ttftMs = Date.now() - started;
          text += chunk.textDelta;
          yield { type: 'delta', text: chunk.textDelta };
        }
        if (chunk.usage) usage = chunk.usage;
        if (chunk.finishReason) finishReason = chunk.finishReason;
      }

      const log = this.buildLog({
        req,
        model,
        status: 'success',
        streaming: true,
        latencyMs: Date.now() - started,
        ttftMs,
        requestTimestamp,
        outputText: text,
        usage,
        finishReason,
      });
      this.shipper.enqueue(log);
      yield { type: 'done', text, usage, finishReason, log };
    } catch (err) {
      const aborted = isAbort(err);
      // Aborted with partial text = cancelled success, not error.
      const log = aborted && text.length > 0
        ? this.buildLog({
            req, model, status: 'success', streaming: true,
            latencyMs: Date.now() - started, ttftMs, requestTimestamp,
            outputText: text, usage, finishReason: 'cancelled',
          })
        : this.buildErrorLog({
            req, model, streaming: true, latencyMs: Date.now() - started,
            requestTimestamp, err, ttftMs,
          });
      this.shipper.enqueue(log);
      throw err;
    }
  }

  flush(): Promise<void> {
    return this.shipper.flush();
  }

  close(): Promise<void> {
    return this.shipper.close();
  }

  private buildLog(p: {
    req: ChatRequest;
    model: string;
    status: 'success';
    streaming: boolean;
    latencyMs: number;
    ttftMs?: number;
    requestTimestamp: string;
    outputText: string;
    usage?: ProviderUsage;
    finishReason?: string;
  }): InferenceLog {
    return {
      eventId: randomUUID(),
      sessionId: p.req.sessionId,
      conversationId: p.req.conversationId,
      messageId: p.req.messageId,
      provider: this.provider.name,
      model: p.model,
      status: p.status,
      streaming: p.streaming,
      latencyMs: p.latencyMs,
      ttftMs: p.ttftMs,
      usage: p.usage,
      finishReason: p.finishReason,
      inputPreview: makePreview(lastUserMessage(p.req.messages)),
      outputPreview: makePreview(p.outputText),
      requestTimestamp: p.requestTimestamp,
      responseTimestamp: new Date().toISOString(),
      sdkVersion: SDK_VERSION,
      metadata: p.req.metadata ?? {},
    };
  }

  private buildErrorLog(p: {
    req: ChatRequest;
    model: string;
    streaming: boolean;
    latencyMs: number;
    requestTimestamp: string;
    err: unknown;
    ttftMs?: number;
  }): InferenceLog {
    const error = toError(p.err);
    return {
      eventId: randomUUID(),
      sessionId: p.req.sessionId,
      conversationId: p.req.conversationId,
      messageId: p.req.messageId,
      provider: this.provider.name,
      model: p.model,
      status: 'error',
      streaming: p.streaming,
      latencyMs: p.latencyMs,
      ttftMs: p.ttftMs,
      finishReason: isAbort(p.err) ? 'cancelled' : undefined,
      inputPreview: makePreview(lastUserMessage(p.req.messages)),
      outputPreview: '',
      error: { type: error.name, message: error.message },
      requestTimestamp: p.requestTimestamp,
      responseTimestamp: new Date().toISOString(),
      sdkVersion: SDK_VERSION,
      metadata: p.req.metadata ?? {},
    };
  }
}

function lastUserMessage(messages: ProviderMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return messages[i]!.content;
  }
  return messages[messages.length - 1]?.content ?? '';
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === 'string' ? err : 'Unknown error');
}
